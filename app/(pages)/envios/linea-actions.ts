'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { getSupplierPriceMap } from '@/lib/suppliers'
import { alternosDe, buscarPorAlterno } from '@/lib/alt-sku'
import { CM3_PER_M3, type ConfigMap } from '@/lib/calc'
import { toConfigMap } from '@/lib/config'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { isForeignKeyViolation } from '@/lib/prisma-errors'

// Costo de compra y MOQ de una pieza para ESTE embarque. El costo sale del proveedor de la
// caja si tiene precio cargado para ese SKU; si no, del precio base de 99rpm en ₹
// convertido. Es lo que se paga por la pieza, sin flete: el flete lo paga el embarque
// entero.
//
// El MOQ solo existe si hay proveedor elegido y si él lo declaró: es un dato SUYO, no de
// la pieza. Sin proveedor no hay MOQ que mostrar — que es correcto, porque tampoco hay
// todavía a quién comprarle.
async function costeador(envioId: number) {
  const [envio, cfgRows] = await Promise.all([
    db.envio.findUnique({ where: { id: envioId }, select: { supplierId: true } }),
    db.config.findMany(),
  ])
  const cfg = toConfigMap(cfgRows)
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  const priceMap = await getSupplierPriceMap(envio?.supplierId ?? null)
  return (productId: number, priceInr: number | null): { costoUsd: number | null; moq: number | null } => {
    const override = priceMap.get(productId)
    if (override) return { costoUsd: override.priceUsd, moq: override.moq }
    return { costoUsd: priceInr != null ? priceInr / inrUsd : null, moq: null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Líneas de mercancía PROPIA dentro de un embarque marítimo.
//
// Son compras, no ventas: producto y cantidad, nada más. No hay precio de venta que
// congelar (cuando la caja llega, la pieza se vende al precio del catálogo como cualquier
// otra), y por eso tampoco hay nada que "recotizar" cuando cambia una tarifa.
//
// Todas las acciones exigen que el embarque esté en BORRADOR: una caja ya cerrada no
// cambia de contenido — si cambiara, el costo que se guardó al cerrarla dejaría de
// describir lo que efectivamente viajó.
// ─────────────────────────────────────────────────────────────────────────────

async function esBorradorMaritimo(envioId: number): Promise<boolean> {
  const e = await db.envio.findUnique({ where: { id: envioId }, select: { estado: true, modo: true } })
  return e?.estado === 'borrador' && e.modo === 'maritimo_cbm'
}

export interface ResultadoSync {
  ok: boolean
  altas: number
  cambios: number
  bajas: number
  error?: string
}

/**
 * Guarda el contenido COMPLETO del embarque de una sola vez.
 *
 * Armar una caja son decenas de altas, bajas y correcciones de cantidad seguidas, y contra
 * una base remota cada una era un viaje de ida y vuelta con revalidación de una pantalla
 * que recalcula CBM y comparación de proveedores. Por eso el armador trabaja sobre un
 * borrador local y manda todo junto: una sola transacción, un solo recálculo.
 *
 * Recibe el estado deseado entero, no una lista de operaciones. Es idempotente (mandar dos
 * veces lo mismo deja la base igual) y no depende de que el cliente haya visto la última
 * versión de cada línea: se compara contra lo que hay y se aplica la diferencia. La
 * contrapartida es que, si el mismo embarque se editara desde dos pestañas, gana la última
 * en guardar — asumible en un borrador de un solo usuario, y por eso mismo esto NO se
 * habilita sobre un embarque cerrado.
 */
export async function sincronizarLineas(
  envioId: number,
  piezas: { productId: number; quantity: number }[],
): Promise<ResultadoSync> {
  if (!(await esBorradorMaritimo(envioId))) {
    return { ok: false, altas: 0, cambios: 0, bajas: 0, error: 'El embarque ya no está en borrador.' }
  }
  if (!Array.isArray(piezas)) {
    return { ok: false, altas: 0, cambios: 0, bajas: 0, error: 'Contenido inválido.' }
  }

  // Una misma pieza puede llegar dos veces (marcada en dos subgrupos del ensamble,
  // izquierdo/derecho): se suman antes de escribir, para no pelear con el índice único
  // (envioId, productId).
  const deseado = new Map<number, number>()
  for (const p of piezas) {
    const id = Number(p.productId)
    const qty = Math.floor(Number(p.quantity))
    if (!Number.isFinite(id) || !Number.isFinite(qty) || qty < 1) continue
    deseado.set(id, (deseado.get(id) ?? 0) + qty)
  }

  // Descontinuadas: no las produce la fábrica, así que no se le pueden comprar a NADIE.
  // Se corta acá y no solo en el cliente porque el bloqueo es una regla del negocio, no un
  // detalle de la pantalla: la línea podía estar cargada desde antes de marcarse el SKU, y
  // guardar el embarque no puede ser la forma de colarla.
  const ids = [...deseado.keys()]
  const nls = ids.length > 0
    ? await db.product.findMany({
        where: { id: { in: ids }, discontinuedAt: { not: null } },
        select: { nameEs: true, bajajCode: true },
      })
    : []
  if (nls.length > 0) {
    const lista = nls.slice(0, 3).map(p => p.bajajCode ?? p.nameEs).join(', ')
    const una = nls.length === 1
    return {
      ok: false, altas: 0, cambios: 0, bajas: 0,
      error: `${nls.length} pieza${una ? '' : 's'} descontinuada${una ? '' : 's'} en el embarque (${lista}${nls.length > 3 ? '…' : ''}). `
        + `Bajaj no ${una ? 'la fabrica' : 'las fabrica'} más: ${una ? 'sacala' : 'sacalas'} antes de guardar.`,
    }
  }

  const actuales = await db.envioLinea.findMany({
    where: { envioId },
    select: { id: true, productId: true, quantity: true },
  })

  const ops = []
  let altas = 0, cambios = 0, bajas = 0
  for (const a of actuales) {
    const q = deseado.get(a.productId)
    if (q == null) {
      ops.push(db.envioLinea.delete({ where: { id: a.id } }))
      bajas++
    } else if (q !== a.quantity) {
      ops.push(db.envioLinea.update({ where: { id: a.id }, data: { quantity: q } }))
      cambios++
    }
    // Lo que queda en el mapa al terminar es lo que no existía: son las altas.
    deseado.delete(a.productId)
  }
  for (const [productId, quantity] of deseado) {
    ops.push(db.envioLinea.create({ data: { envioId, productId, quantity } }))
    altas++
  }

  if (ops.length === 0) return { ok: true, altas: 0, cambios: 0, bajas: 0 }

  try {
    await db.$transaction(ops)
  } catch (e) {
    // El borrador del cliente queda intacto: si falla, no se perdió lo que venías armando.
    return {
      ok: false, altas: 0, cambios: 0, bajas: 0,
      error: e instanceof Error ? e.message : 'No se pudo guardar.',
    }
  }

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')   // la lista muestra flete y landed en vivo, y esto los mueve
  return { ok: true, altas, cambios, bajas }
}

// Componentes de UN ensamble, on-demand al seleccionarlo (traer los ~14k del catálogo de
// una sería inmanejable). Se informa si le faltan medidas: por mar, una pieza sin
// dimensiones no suma volumen al embarque y el m³ que ves queda corto.
export async function componentesDeEnsamble(assemblyId: number, envioId: number) {
  const costoDe = await costeador(envioId)
  const comps = await db.productComponent.findMany({
    where: { parentId: assemblyId },
    include: {
      child: {
        select: {
          id: true, nameEs: true, bajajCode: true, priceInr: true, compatibleModels: true,
          weightGrams: true, dimL: true, dimA: true, dimH: true, discontinuedAt: true,
        },
      },
    },
    orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  })
  // El otro código del par, para las piezas que tienen dos: es el número con el que el
  // proveedor la lista, y sin él la fila parece otra pieza distinta.
  const alternos = await alternosDe(comps.map(c => c.child.id))

  return comps.map(c => {
    const { costoUsd, moq } = costoDe(c.child.id, c.child.priceInr)
    return {
      id: c.id,
      groupName: c.groupName,
      quantity: c.quantity,
      child: {
        id: c.child.id,
        nameEs: c.child.nameEs,
        bajajCode: c.child.bajajCode,
        altCode: alternos.get(c.child.id) ?? null,
        // A qué motos sirve ESTA pieza. El ensamble nace scopeado a una sola moto (hay 11
        // "Front Brake Lever", uno por bici), pero sus piezas coinciden de a pedazos: la
        // manilla sirve a 8 motos y el microswitch se parte en dos SKUs. Sin este dato,
        // recorrer la segunda moto es adivinar si estás repitiendo o sumando algo nuevo.
        compatibleModels: c.child.compatibleModels,
        // Costo de compra unitario y cantidad mínima con el proveedor de este embarque.
        costoUsd,
        moq,
        // Bajaj no la fabrica más: no la consigue ningún proveedor, así que no entra a la
        // caja. Se manda igual a la pantalla para poder mostrarla tachada — verla y saber
        // por qué no se puede es más útil que que desaparezca del despiece.
        descontinuada: c.child.discontinuedAt != null,
        dimL: c.child.dimL,
        dimA: c.child.dimA,
        dimH: c.child.dimH,
        sinMedidas: !(c.child.dimL && c.child.dimA && c.child.dimH) || c.child.weightGrams == null,
        weightKg: c.child.weightGrams != null ? c.child.weightGrams / 1000 : 0,
        // Volumen de UNA unidad, en m³ — lo que va a sumar al embarque.
        volumeM3: c.child.dimL && c.child.dimA && c.child.dimH
          ? (c.child.dimL * c.child.dimA * c.child.dimH) / CM3_PER_M3
          : 0,
      },
    }
  })
}

// Cambia el proveedor del embarque. Solo en borrador: una vez cerrado, el proveedor es un
// hecho de lo que ya se compró, y moverlo reescribiría el costo de una caja que ya viajó.
export async function cambiarProveedor(envioId: number, supplierId: number | null): Promise<ActionResult> {
  if (!(await esBorradorMaritimo(envioId))) return fallo('El embarque ya no está en borrador: el proveedor quedó fijo.')
  try {
    await db.envio.update({ where: { id: envioId }, data: { supplierId } })
  } catch (e) {
    // El proveedor se borró desde otra pestaña después de armar el selector.
    if (isForeignKeyViolation(e)) return fallo('Ese proveedor ya no existe. Recargá la página.')
    throw e
  }
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  return ok()
}

// Las transiciones de estado de un embarque (cerrar, reabrir, recibir, deshacer) NO leen el
// estado para después escribirlo: el cambio de estado es la condición de la escritura
// (`updateMany where estado = <el que esperaba>`). Postgres serializa dos escrituras sobre la
// misma fila, así que si dos requests llegan a la vez (doble click, dos pestañas) la segunda
// espera a la primera, vuelve a evaluar el `where`, ya no encuentra la fila y devuelve
// `count: 0` — no hace nada. Con "leer y después escribir", las dos leían el estado viejo y
// las dos corrían el efecto lateral (sumar o restar el stock).

// Cierra el borrador. A partir de acá el contenido queda fijo y el embarque es lo que
// efectivamente se mandó. Una caja vacía no se cierra: no hay embarque.
export async function cerrarEmbarque(envioId: number) {
  const r = await db.envio.updateMany({
    where: { id: envioId, modo: 'maritimo_cbm', estado: 'borrador', lineas: { some: {} } },
    data: { estado: 'confirmado' },
  })
  if (r.count === 0) return
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
}

// Solo puede volver a borrador una caja que todavía no llegó ('confirmado'). Una
// 'entregado' ya sumó su contenido a stock (ver recibirEmbarque): reabrirla para editarla
// dejaría ese stock describiendo una caja que ya cambió — primero hay que deshacer la
// recepción, que resta lo que se sumó.
export async function reabrirEmbarque(envioId: number) {
  const r = await db.envio.updateMany({
    where: { id: envioId, modo: 'maritimo_cbm', estado: 'confirmado' },
    data: { estado: 'borrador' },
  })
  if (r.count === 0) return
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
}

// Una transacción interactiva con la base remota paga un viaje por sentencia, y el tiempo
// por defecto (5 s) es justo. Con tres sentencias sobra, pero se explicita por si la
// latencia sube: que una recepción expire a medias no deja nada inconsistente (es todo una
// transacción), solo obliga a reintentar.
const TX_OPTS = { maxWait: 10_000, timeout: 20_000 } as const

// Marca la caja como recibida: a partir de acá deja de estar "en camino" (ver
// mercanciaEnCamino) y cada EnvioLinea se suma a Product.stock, en la misma transacción —
// un solo dato, sin transcribirlo pieza por pieza a mano en cada producto. Sin cliente
// detrás (es mercancía propia), "recibido" es directamente "ya está en el depósito".
//
// El stock se suma con UNA sentencia (UPDATE … FROM EnvioLinea) en vez de un update por
// línea: una caja tiene decenas de piezas y cada update era un viaje a us-west-2. Es seguro
// porque (envioId, productId) es único en EnvioLinea: cada producto recibe una sola suma.
export async function recibirEmbarque(envioId: number) {
  await db.$transaction(async tx => {
    const r = await tx.envio.updateMany({
      where: { id: envioId, modo: 'maritimo_cbm', estado: 'confirmado', lineas: { some: {} } },
      data: { estado: 'entregado', entregadoAt: new Date() },
    })
    // Otra request ya la recibió (o no está en condiciones de recibirse): no se suma nada.
    if (r.count === 0) return

    await tx.$executeRaw`
      UPDATE "Product" AS p
      SET "stock" = p."stock" + l."quantity", "updatedAt" = NOW()
      FROM "EnvioLinea" AS l
      WHERE l."envioId" = ${envioId} AND l."productId" = p."id"`
  }, TX_OPTS)

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/contabilidad')
  revalidatePath('/products')
  revalidatePath('/')
}

// El contrapeso: por si se marcó por error. Resta de stock lo que recibirEmbarque sumó y
// vuelve la caja a 'confirmado' (no a 'borrador' — su contenido sigue siendo el que
// efectivamente se compró; para editarlo hace falta reabrirEmbarque aparte).
//
// Se niega si alguna pieza ya no tiene en stock lo que esta caja le sumó: deshacer dejaría
// el stock en negativo, o sea, afirmaría que se vendió algo que no existía. Para deshacer
// hay que primero ajustar ese stock a mano. Tira (y la transacción entera se revierte, la
// caja sigue 'entregado') en vez de devolver un error porque es un `action` de form.
export async function deshacerRecepcion(envioId: number) {
  await db.$transaction(async tx => {
    const r = await tx.envio.updateMany({
      where: { id: envioId, modo: 'maritimo_cbm', estado: 'entregado' },
      data: { estado: 'confirmado', entregadoAt: null },
    })
    if (r.count === 0) return

    const faltantes = await tx.$queryRaw<{ nameEs: string; bajajCode: string | null }[]>`
      SELECT p."nameEs", p."bajajCode"
      FROM "Product" AS p
      JOIN "EnvioLinea" AS l ON l."productId" = p."id"
      WHERE l."envioId" = ${envioId} AND p."stock" < l."quantity"
      LIMIT 3`
    if (faltantes.length > 0) {
      const lista = faltantes.map(f => f.bajajCode ?? f.nameEs).join(', ')
      throw new Error(
        `No se puede deshacer la recepción: ya no hay en stock lo que esta caja sumó (${lista}). ` +
        `Se vendió o se ajustó a mano; corregí ese stock primero.`,
      )
    }

    await tx.$executeRaw`
      UPDATE "Product" AS p
      SET "stock" = p."stock" - l."quantity", "updatedAt" = NOW()
      FROM "EnvioLinea" AS l
      WHERE l."envioId" = ${envioId} AND l."productId" = p."id"`
  }, TX_OPTS)

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/contabilidad')
  revalidatePath('/products')
  revalidatePath('/')
}

// Buscador para el armador del embarque (server-side, como el de presupuestos: son ~5.8k
// productos y no tiene sentido mandarlos al navegador).
const CAMPOS_BUSQUEDA = {
  id: true, nameEs: true, bajajCode: true, priceInr: true, compatibleModels: true,
  weightGrams: true, dimL: true, dimA: true, dimH: true, imageUrl: true, discontinuedAt: true,
} as const

const TOPE_BUSQUEDA = 12

export async function buscarProductos(term: string, envioId: number) {
  const q = term.trim()
  if (q.length < 2) return []
  const costoDe = await costeador(envioId)
  const rows = await db.product.findMany({
    where: {
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: CAMPOS_BUSQUEDA,
    take: TOPE_BUSQUEDA,
    orderBy: { nameEs: 'asc' },
  })

  // Segunda pasada por el OTRO código del par. Va después y solo por lo que falta para
  // llenar el tope: tipear un código propio tiene que seguir devolviendo esa pieza
  // primero. Los alternos son el rescate de lo que hoy no aparecía — el proveedor cotiza
  // con SU número y tipearlo daba "sin resultados" aunque la pieza estuviera cargada.
  const yaEstan = new Set(rows.map(r => r.id))
  const idsAlternos = await buscarPorAlterno(q, yaEstan, TOPE_BUSQUEDA - rows.length)
  const porAlterno = idsAlternos.length > 0
    ? await db.product.findMany({ where: { id: { in: idsAlternos } }, select: CAMPOS_BUSQUEDA, orderBy: { nameEs: 'asc' } })
    : []

  const todos = [...rows, ...porAlterno]
  const alternos = await alternosDe(todos.map(p => p.id))

  return todos.map(p => {
    const { costoUsd, moq } = costoDe(p.id, p.priceInr)
    return {
      id: p.id,
      nameEs: p.nameEs,
      bajajCode: p.bajajCode,
      // El otro número de la misma pieza. Se muestra siempre que exista, no solo cuando
      // fue el que matcheó: es el código con el que hay que pedirla al proveedor.
      altCode: alternos.get(p.id) ?? null,
      compatibleModels: p.compatibleModels,
      costoUsd,
      moq,
      dimL: p.dimL,
      dimA: p.dimA,
      dimH: p.dimH,
      imageUrl: p.imageUrl,
      // Peso y volumen de UNA unidad: con esto el armador proyecta el m³ y los kg de la
      // caja sin volver al server en cada pieza que agregás.
      weightKg: p.weightGrams != null ? p.weightGrams / 1000 : 0,
      volumeM3: p.dimL && p.dimA && p.dimH ? (p.dimL * p.dimA * p.dimH) / CM3_PER_M3 : 0,
      // Sin dimensiones no hay volumen, y sin volumen esta pieza no se puede costear por mar.
      sinMedidas: !(p.dimL && p.dimA && p.dimH) || p.weightGrams == null,
      // Descontinuada de fábrica: aparece en la búsqueda pero no se puede agregar. Que siga
      // saliendo es deliberado — si la buscás es porque la necesitás, y "no existe" y "ya no
      // se fabrica" mandan a hacer cosas distintas.
      descontinuada: p.discontinuedAt != null,
    }
  })
}
