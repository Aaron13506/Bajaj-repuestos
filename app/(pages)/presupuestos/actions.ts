'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'
import { claveLinea, nombreEnsamble, type RefLinea } from '@/lib/linea-pedido'
import { findOrCreateCliente, revalidateClientes } from '@/lib/clientes'
import { isDelivered } from '@/lib/shipping-status'
import { listarFaltantes, piezasDeLinea, type LineaStock } from '@/lib/stock-piezas'
import { resolverDePiezas } from '@/lib/inventario'
import { ok, fallo, conErrorDeNegocio, ErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { motivoNoEliminable } from '@/lib/pedido-eliminable'
import { isForeignKeyViolation } from '@/lib/prisma-errors'
import { cuentaDeMetodo, datosBs, leerCobroBs, type CobroEnBs } from '@/lib/cuentas'
import { bloquearPedido, cobrarPedido, descontarIngresosPedido } from '@/lib/movimientos'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap } from '@/lib/config'
import { bloquearDescontinuadas } from '@/lib/descontinuadas'
import { estadoValidez, escalonDelPresupuesto, motivoNoAprobable, validezDias } from '@/lib/validez'
import { describirOps, planEdicion, estadoLinea, type LineaActual, type LineaNueva } from '@/lib/pedido-edicion'
import { pasarAStockPropio, registrarEvento, SELECT_LINEA_MOVIBLE } from '@/lib/pedido-derivado'
import { cerradosPorEdicion } from '@/lib/incidencias'
import { notaCobroBcv, realDeCobro, resumenCobro } from '@/lib/cobro-bcv'
import { cobraEnBolivares } from '@/lib/pagos'

type Tx = Prisma.TransactionClient

// Lo que hace falta para convertir un cobro escrito en el formulario a dólares reales: las
// líneas (para el total y el saldo BCV) y el escalón congelado del pedido.
async function lineasYEscalon(tx: Tx, pedidoId: number) {
  const p = await tx.pedido.findUniqueOrThrow({
    where: { id: pedidoId },
    select: {
      tipo: true, brechaEscalonPct: true, createdAt: true, cotizadoAt: true, escalonCotizadoPct: true,
      items: { select: { salePrice: true, quantity: true, productId: true, ensambleId: true } },
    },
  })
  return {
    tipo: p.tipo,
    escalon: p.brechaEscalonPct != null ? Number(p.brechaEscalonPct) : null,
    // El escalón con el que se le presentó el presupuesto al cliente (null = uno anterior a esto).
    escalonCotizado: p.escalonCotizadoPct != null ? Number(p.escalonCotizadoPct) : null,
    fechas: { cotizadoAt: p.cotizadoAt, createdAt: p.createdAt },
    refs: p.items.map(i => ({ productId: i.productId, ensambleId: i.ensambleId })),
    lineas: p.items.map(i => ({ salePrice: Number(i.salePrice), quantity: i.quantity })),
  }
}

// Una línea es una pieza (productId) O un conjunto (ensambleId + snapshot de piezas).
interface ItemInput extends RefLinea {
  quantity: number
  salePrice: number
  bundleItems?: BundlePiece[] | null
}

/**
 * Lee y valida las líneas que manda el armador.
 *
 * Era un `JSON.parse(formData.get('items') as string)` pelado: un payload cortado tiraba
 * un SyntaxError crudo, y una cantidad en 0 o un precio negativo entraban tal cual a un
 * documento comercial. También rechaza el mismo producto (o el mismo conjunto) dos veces,
 * porque PedidoItem tiene `@@unique([pedidoId, productId])` y `@@unique([pedidoId, ensambleId])`:
 * pasaba como un P2002 ilegible, y fusionar las cantidades en silencio sería peor —hay dos
 * precios de venta y ninguno es más cierto que el otro.
 *
 * Y exige la forma que la base exige (CHECK PedidoItem_pieza_xor_conjunto y
 * PedidoItem_conjunto_lleva_piezas): una pieza suelta no lleva snapshot, un conjunto no puede
 * ir sin piezas. Con una pestaña vieja —que mandaba el ensamble como `productId`— el rechazo
 * llega acá con un texto, y no como una violación de CHECK sin explicación.
 */
function parseItems(formData: FormData): ItemInput[] {
  let crudo: unknown
  try {
    crudo = JSON.parse((formData.get('items') as string) ?? '')
  } catch {
    throw new ErrorDeNegocio('No se pudieron leer las líneas del presupuesto (JSON inválido).')
  }
  if (!Array.isArray(crudo)) throw new ErrorDeNegocio('Las líneas del presupuesto llegaron en un formato inesperado.')

  const vistos = new Set<string>()
  return crudo.map((raw, i): ItemInput => {
    const it = raw as Partial<Record<keyof ItemInput, unknown>>
    const id = (v: unknown) => (v == null ? null : Number(v))
    const productId = id(it.productId)
    const ensambleId = id(it.ensambleId)
    const quantity = Number(it.quantity)
    const salePrice = Number(it.salePrice)
    const bundleItems = Array.isArray(it.bundleItems) && it.bundleItems.length > 0 ? (it.bundleItems as BundlePiece[]) : null

    const esId = (n: number | null): n is number => n != null && Number.isInteger(n) && n > 0
    if ((productId == null) === (ensambleId == null)) throw new ErrorDeNegocio(`Línea ${i + 1}: tiene que ser una pieza o un conjunto, no las dos ni ninguna. Recargá la página.`)
    if (productId != null && !esId(productId)) throw new ErrorDeNegocio(`Línea ${i + 1}: producto inválido.`)
    if (ensambleId != null && !esId(ensambleId)) throw new ErrorDeNegocio(`Línea ${i + 1}: ensamble inválido.`)
    if (ensambleId != null && !bundleItems) throw new ErrorDeNegocio(`Línea ${i + 1}: un conjunto necesita al menos una pieza.`)
    if (productId != null && bundleItems) throw new ErrorDeNegocio(`Línea ${i + 1}: una pieza suelta no lleva desglose. Recargá la página.`)
    if (!Number.isInteger(quantity) || quantity < 1) throw new ErrorDeNegocio(`Línea ${i + 1}: la cantidad tiene que ser un entero ≥ 1.`)
    if (!Number.isFinite(salePrice) || salePrice < 0) throw new ErrorDeNegocio(`Línea ${i + 1}: el precio de venta no es un número válido.`)

    const linea = { productId, ensambleId }
    const clave = claveLinea(linea)
    if (vistos.has(clave)) {
      throw new ErrorDeNegocio(`${ensambleId != null ? 'El conjunto' : 'El producto'} ${ensambleId ?? productId} aparece dos veces en el presupuesto.`)
    }
    vistos.add(clave)

    return { ...linea, quantity, salePrice, bundleItems }
  })
}

// Un conjunto vendido a precio único guarda el snapshot de sus piezas; una pieza suelta
// guarda NULL. En un update hay que decirlo explícito (DbNull), porque `undefined` en
// Prisma significa "no toques la columna" y dejaría pegado el snapshot de un conjunto que
// dejó de serlo.
function snapshotBundle(items: BundlePiece[] | null | undefined) {
  return items && items.length > 0
    ? (items as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull
}

// Resuelve el Cliente elegido en el builder: existente (clienteId) o uno nuevo
// creado al vuelo (nuevoClienteNombre). Solo aplica a tipo 'cliente' — el stock
// propio (tipo 'propio') no lleva Cliente, sigue con clientName de texto libre.
async function resolveCliente(formData: FormData) {
  const clienteIdRaw = (formData.get('clienteId') as string) ?? ''
  if (clienteIdRaw === '__new__') {
    const nombre = (formData.get('nuevoClienteNombre') as string)?.trim()
    if (!nombre) return null
    const telefono = (formData.get('nuevoClienteTelefono') as string)?.trim() || null
    const { cliente } = await findOrCreateCliente(nombre, telefono)
    return cliente
  }
  const id = parseInt(clienteIdRaw)
  if (isNaN(id)) return null
  return db.cliente.findUnique({ where: { id } })
}

// Devuelve `ActionResult` (y no `void`): en el éxito hace `redirect`, así que lo único que
// el cliente llega a recibir es el motivo de un rechazo — antes un `return` mudo (sin cliente,
// sin líneas) era indistinguible de guardar y el armador quedaba trabado en "Guardando…".
export async function createPresupuesto(formData: FormData): Promise<ActionResult> {
  return conErrorDeNegocio(() => crearPresupuesto(formData))
}

async function crearPresupuesto(formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const tipo = (formData.get('tipo') as string) === 'propio' ? 'propio' : 'cliente'
  const items = parseItems(formData)

  if (items.length === 0) throw new ErrorDeNegocio('Agregá al menos una pieza.')
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) throw new ErrorDeNegocio('Ponele un nombre a este stock propio.')
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) throw new ErrorDeNegocio('Elegí un cliente, o escribí el nombre del nuevo.')
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  // El stock propio es una compra definida para revender: entra directo como
  // pedido (no necesita aprobación ni adelanto). El de cliente arranca como presupuesto.
  const status = tipo === 'propio' ? 'pedido' : 'presupuesto'

  // Un presupuesto de cliente se cotiza con el escalón de hoy y desde hoy: es lo que el cliente
  // va a ver y lo que se le va a cobrar mientras esté vigente (lib/validez.ts).
  const cotizacion = tipo === 'cliente'
    ? { cotizadoAt: new Date(), escalonCotizadoPct: escalonBcvVigente(toConfigMap(await db.config.findMany())) }
    : {}

  const pedido = await db.pedido.create({
    data: {
      clientName,
      clienteId,
      notas,
      tipo,
      status,
      ...cotizacion,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          ensambleId: i.ensambleId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          bundleItems: snapshotBundle(i.bundleItems),
        })),
      },
    },
  })

  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect(`/presupuestos/${pedido.id}`)
}

/**
 * Guarda los cambios de un presupuesto SIN tocar el eje logístico de las líneas que
 * sobreviven a la edición.
 *
 * Antes eran dos statements sueltos: `deleteMany` de todos los ítems y después un
 * `create` de la lista nueva. Dos problemas, y el segundo es el caro:
 *
 * 1. NO ERA ATÓMICO. Si el `create` fallaba —un producto borrado, un P2002, un corte de
 *    red a us-west-2— los ítems ya estaban borrados y no volvían. Un presupuesto vacío,
 *    de un documento que suele tener el 50% cobrado de seña.
 *
 * 2. BORRABA EL EJE LOGÍSTICO EN CADA EDICIÓN. PedidoItem no es solo precio y cantidad:
 *    es la unidad de compra (envioId, shippingStatus, shippingStatusAt, supplierId,
 *    origen, inbound, isLanded, costRealUsd, compradoAt). Recrear la línea le ponía a
 *    todo eso el default. Tocabas una cantidad y la pieza perdía en qué caja viajaba y
 *    en qué etapa estaba. Es alcanzable hoy: el stock propio nace en status 'pedido',
 *    se edita siempre, y es justo lo que se asigna a un embarque.
 *
 * Ahora se hace por diferencia: se borra lo que el usuario sacó, se actualiza lo que
 * sigue —solo cantidad, precio y snapshot— y se crea lo que agregó. Todo en UN
 * $transaction por lotes (no interactivo) para que sea un viaje y no uno por línea:
 * con 30 líneas contra Supabase, la versión interactiva se comía el timeout de 5 s.
 */
export async function updatePresupuesto(id: number, formData: FormData): Promise<ActionResult> {
  return conErrorDeNegocio(() => editarPresupuesto(id, formData))
}

async function editarPresupuesto(id: number, formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const existing = await db.pedido.findUnique({
    where: { id },
    select: {
      tipo: true, status: true,
      items: { select: { productId: true, ensambleId: true, quantity: true, shippingStatus: true, bundleItems: true } },
    },
  })
  if (!existing) throw new ErrorDeNegocio(`El presupuesto #${id} ya no existe.`)
  if (existing.status === 'cancelado') throw new ErrorDeNegocio('Este pedido está cancelado: no se edita.')
  // Un pedido de cliente ya confirmado también se edita, pero con otras reglas: sus líneas pueden
  // estar compradas (ver editarPedidoConfirmado).
  if (existing.tipo === 'cliente' && existing.status === 'pedido') return editarPedidoConfirmado(id, formData)

  // El mismo candado que la página (edit/page.tsx). Estaba SOLO en la página, así que una
  // pestaña vieja o un POST directo editaba un pedido de cliente ya confirmado. El resto
  // de las acciones del repo ya revalidan su guard del lado del server (ver
  // esBorradorMaritimo en envios/linea-actions); esta se había quedado afuera.
  const editable = existing.status === 'presupuesto' || existing.tipo === 'propio'
  if (!editable) {
    throw new ErrorDeNegocio('Este pedido ya está confirmado y no se puede editar.')
  }

  const items = parseItems(formData)
  if (items.length === 0) throw new ErrorDeNegocio('Agregá al menos una pieza.')
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (existing.tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) throw new ErrorDeNegocio('Ponele un nombre a este stock propio.')
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) throw new ErrorDeNegocio('Elegí un cliente, o escribí el nombre del nuevo.')
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  // La identidad de una línea es pieza-o-conjunto (claveLinea), no solo productId: un id de
  // pieza y uno de ensamble pueden coincidir.
  const antes = new Set(existing.items.map(claveLinea))
  const ahora = new Set(items.map(claveLinea))
  const sacadas = existing.items.filter(i => !ahora.has(claveLinea(i)))
  const piezasSacadas = sacadas.flatMap(i => (i.productId != null ? [i.productId] : []))
  const conjuntosSacados = sacadas.flatMap(i => (i.ensambleId != null ? [i.ensambleId] : []))

  const ops: Prisma.PrismaPromise<unknown>[] = []

  if (piezasSacadas.length > 0) {
    ops.push(db.pedidoItem.deleteMany({ where: { pedidoId: id, productId: { in: piezasSacadas } } }))
  }
  if (conjuntosSacados.length > 0) {
    ops.push(db.pedidoItem.deleteMany({ where: { pedidoId: id, ensambleId: { in: conjuntosSacados } } }))
  }

  for (const i of items.filter(i => antes.has(claveLinea(i)))) {
    ops.push(db.pedidoItem.update({
      where: i.ensambleId != null
        ? { pedidoId_ensambleId: { pedidoId: id, ensambleId: i.ensambleId } }
        : { pedidoId_productId: { pedidoId: id, productId: i.productId! } },
      // Solo lo comercial. Todo lo logístico queda como estaba, que es el punto.
      data: { quantity: i.quantity, salePrice: i.salePrice, bundleItems: snapshotBundle(i.bundleItems) },
    }))
  }

  // Stock propio: una línea ya 'entregado' SUMÓ su cantidad a Product.stock cuando llegó (ver
  // saveItemChanges). Si acá se cambia la cantidad o se saca la línea, el stock tiene que
  // acompañarlo, o queda describiendo una entrega que ya no es la del documento: se edita la
  // cantidad de 10 a 6 y el depósito sigue diciendo que entraron 10. El ajuste va en la misma
  // transacción que la edición. Las líneas que todavía no llegaron no tocan stock.
  //
  // Un conjunto entregado sumó sus PIEZAS (ver lib/stock-piezas), así que se compara pieza por
  // pieza lo que sumó (cantidad y snapshot viejos) contra lo que sumaría ahora (los nuevos):
  // cambiar la cantidad, destildar una pieza o sacar el conjunto mueven lo que corresponde.
  const ajusteStock = new Map<number, number>()
  if (existing.tipo === 'propio') {
    const ahoraPorClave = new Map(items.map(i => [claveLinea(i), i]))
    const antesLineas: LineaStock[] = []
    const ahoraLineas: LineaStock[] = []
    for (const it of existing.items) {
      if (!isDelivered(it.shippingStatus)) continue
      antesLineas.push({ productId: it.productId, quantity: it.quantity, bundleItems: it.bundleItems as BundlePiece[] | null })
      const nueva = ahoraPorClave.get(claveLinea(it))
      if (nueva) ahoraLineas.push({ productId: nueva.productId, quantity: nueva.quantity, bundleItems: nueva.bundleItems ?? null })
    }
    const resolver = await resolverDePiezas([...antesLineas, ...ahoraLineas])
    const faltan: BundlePiece[] = []
    const acumular = (lineas: LineaStock[], signo: number) => {
      for (const l of lineas) {
        const r = piezasDeLinea(l, resolver)
        faltan.push(...r.faltan)
        for (const p of r.piezas) ajusteStock.set(p.productId, (ajusteStock.get(p.productId) ?? 0) + signo * p.unidades)
      }
    }
    acumular(antesLineas, -1)
    acumular(ahoraLineas, 1)
    if (faltan.length > 0) {
      throw new ErrorDeNegocio(
        `Hay piezas de un conjunto ya entregado que no se pueden identificar en el catálogo (${listarFaltantes(faltan)}): ` +
        `no se puede ajustar su stock. Cargalas como producto primero.`,
      )
    }
    for (const [pid, d] of ajusteStock) if (d === 0) ajusteStock.delete(pid)
  }
  if (ajusteStock.size > 0) {
    // Bajar la cantidad entregada resta del depósito: si eso ya se vendió, el stock quedaría
    // en negativo, o sea, afirmaría que se vendió lo que no existía.
    const bajan = [...ajusteStock].filter(([, d]) => d < 0).map(([pid]) => pid)
    if (bajan.length > 0) {
      const prods = await db.product.findMany({
        where: { id: { in: bajan } },
        select: { id: true, stock: true, nameEs: true, bajajCode: true },
      })
      const corto = prods.filter(pr => pr.stock + ajusteStock.get(pr.id)! < 0)
      if (corto.length > 0) {
        const lista = corto.slice(0, 3).map(pr => pr.bajajCode ?? pr.nameEs).join(', ')
        throw new ErrorDeNegocio(
          `No se puede reducir lo ya entregado: el stock de ${lista}${corto.length > 3 ? '…' : ''} no alcanza ` +
          `para descontarlo (se vendió o se ajustó a mano). Corregí ese stock primero.`,
        )
      }
    }
    for (const [productId, delta] of ajusteStock) {
      ops.push(db.product.update({ where: { id: productId }, data: { stock: { increment: delta } } }))
    }
  }

  const nuevos = items.filter(i => !antes.has(claveLinea(i)))
  if (nuevos.length > 0) {
    ops.push(db.pedidoItem.createMany({
      data: nuevos.map(i => ({
        pedidoId: id,
        productId: i.productId,
        ensambleId: i.ensambleId,
        quantity: i.quantity,
        salePrice: i.salePrice,
        bundleItems: snapshotBundle(i.bundleItems),
      })),
    }))
  }

  // Guardar un presupuesto de cliente lo vuelve a cotizar: es otro documento que el cliente va a
  // ver, así que corre la validez y se congela el escalón de hoy (lib/validez.ts).
  const cotizacion = existing.tipo === 'cliente' && existing.status === 'presupuesto'
    ? { cotizadoAt: new Date(), escalonCotizadoPct: escalonBcvVigente(toConfigMap(await db.config.findMany())) }
    : {}
  ops.push(db.pedido.update({ where: { id }, data: { clientName, clienteId, notas, ...cotizacion } }))

  await db.$transaction(ops)

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidateClientes()
  if (ajusteStock.size > 0) {
    revalidatePath('/contabilidad')
    revalidatePath('/products')
    revalidatePath('/')
  }
  redirect(`/presupuestos/${id}`)
}

/**
 * Edita un pedido de cliente YA confirmado.
 *
 * Es lo más común del negocio por encargo —el proveedor no tiene la pieza, Bajaj la reemplazó por
 * otro código, el cliente pide menos— y antes no tenía camino. Lo que lo hace delicado es que
 * las líneas pueden estar compradas: la plata salió y la pieza viaja en una caja. Qué se puede
 * hacer con cada una lo decide `planEdicion` (lib/pedido-edicion.ts): lo que nunca se compró se
 * cambia, se quita o se agrega libremente; lo comprado solo admite otro precio o menos unidades
 * (las de más pasan a stock propio con su costo, nada se pierde por el camino); lo entregado no
 * se toca.
 *
 * Todo corre bajo el cerrojo del pedido y lee las líneas DENTRO de la transacción: una compra
 * registrada mientras el formulario estaba abierto cambia lo que se puede hacer con esa línea, y
 * decidir con la lectura vieja sacaría de un pedido una pieza que ya se pagó.
 *
 * No devuelve plata sola: si el total baja de lo cobrado, el pedido queda con saldo a favor y la
 * pantalla ofrece devolverlo — es una decisión que se toma con el cliente.
 */
async function editarPedidoConfirmado(id: number, formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const items = parseItems(formData)
  if (items.length === 0) {
    throw new ErrorDeNegocio('Un pedido no puede quedarse sin piezas. Si el cliente ya no quiere nada, cancelalo.')
  }

  // Los nombres de lo que se agrega, para el historial (una línea nueva todavía no tiene fila).
  const prodIds = [...new Set(items.flatMap(i => (i.productId != null ? [i.productId] : [])))]
  const ensIds = [...new Set(items.flatMap(i => (i.ensambleId != null ? [i.ensambleId] : [])))]
  const [prods, enss] = await Promise.all([
    prodIds.length ? db.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, nameEs: true } }) : [],
    ensIds.length ? db.ensamble.findMany({ where: { id: { in: ensIds } }, select: { id: true, nameEs: true, nameEn: true } }) : [],
  ])
  const nombres = new Map<string, string>([
    ...prods.map(p => [`p${p.id}`, p.nameEs] as [string, string]),
    ...enss.map(e => [`e${e.id}`, nombreEnsamble(e)] as [string, string]),
  ])
  const nuevas: LineaNueva[] = items.map(i => ({
    nombre: nombres.get(claveLinea(i)),
    productId: i.productId,
    ensambleId: i.ensambleId,
    quantity: i.quantity,
    salePrice: i.salePrice,
    bundleItems: i.bundleItems ?? null,
  }))

  await db.$transaction(async tx => {
    const actual = await bloquearPedido(tx, id)
    if (!actual) throw new ErrorDeNegocio(`El pedido #${id} ya no existe.`)
    if (actual.status !== 'pedido') throw new ErrorDeNegocio('El pedido cambió de estado mientras lo editabas. Recargá la página.')

    const pedido = await tx.pedido.findUniqueOrThrow({
      where: { id },
      select: {
        clientName: true,
        items: {
          select: {
            ...SELECT_LINEA_MOVIBLE,
            product: { select: { nameEs: true } },
            ensamble: { select: { nameEs: true, nameEn: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    })
    const actuales: LineaActual[] = pedido.items.map(it => ({
      id: it.id,
      productId: it.productId,
      ensambleId: it.ensambleId,
      quantity: it.quantity,
      salePrice: Number(it.salePrice),
      bundleItems: it.bundleItems,
      shippingStatus: it.shippingStatus,
      costRealUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null,
      nombre: it.product?.nameEs ?? (it.ensamble ? nombreEnsamble(it.ensamble) : 'una línea'),
    }))

    const plan = planEdicion(actuales, nuevas)
    if (plan.error) throw new ErrorDeNegocio(plan.error)

    // Lo que se agrega o se reescribe tiene que poder comprarse; lo ya comprado no se vuelve a juzgar.
    await bloquearDescontinuadas(
      plan.ops.flatMap(o => (o.op === 'crear' || o.op === 'actualizar' ? [o.nueva] : [])),
    )

    const porId = new Map(pedido.items.map(it => [it.id, it]))
    const sobrantes: { linea: (typeof pedido.items)[number]; unidades: number; precio: number | null }[] = []

    for (const o of plan.ops) {
      switch (o.op) {
        case 'crear':
          await tx.pedidoItem.create({
            data: {
              pedidoId: id,
              productId: o.nueva.productId,
              ensambleId: o.nueva.ensambleId,
              quantity: o.nueva.quantity,
              salePrice: o.nueva.salePrice,
              bundleItems: snapshotBundle(o.nueva.bundleItems as BundlePiece[] | null),
            },
          })
          break
        case 'quitar':
          // Un "no disponible" abierto de una línea que se saca ya está resuelto: se cambió por otra.
          await tx.incidencia.updateMany({
            where: { itemId: o.actual.id, estado: 'abierta', tipo: 'no_disponible' },
            data: { estado: 'resuelta', resolucion: 'sustituida', resueltaAt: new Date() },
          })
          await tx.pedidoItem.delete({ where: { id: o.actual.id } })
          break
        case 'actualizar':
          await tx.pedidoItem.update({
            where: { id: o.actual.id },
            data: {
              quantity: o.nueva.quantity,
              salePrice: o.nueva.salePrice,
              bundleItems: snapshotBundle(o.nueva.bundleItems as BundlePiece[] | null),
            },
          })
          // Faltaba UN SKU del conjunto y ya no lo lleva: ese problema está resuelto (se cambió el
          // pedido), sin ir a cerrarlo a mano. Los demás problemas de la línea siguen abiertos.
          if (Array.isArray(o.nueva.bundleItems)) {
            const abiertas = await tx.incidencia.findMany({
              where: { itemId: o.actual.id, estado: 'abierta', tipo: 'no_disponible', pieza: { not: null } },
              select: { id: true, tipo: true, pieza: true },
            })
            const cerrar = cerradosPorEdicion(abiertas, o.nueva.bundleItems as BundlePiece[])
            if (cerrar.length > 0) {
              await tx.incidencia.updateMany({
                where: { id: { in: cerrar } },
                data: { estado: 'resuelta', resolucion: 'sustituida', resueltaAt: new Date() },
              })
            }
          }
          break
        case 'precio':
          await tx.pedidoItem.update({ where: { id: o.actual.id }, data: { salePrice: o.nueva.salePrice } })
          break
        case 'sobrante':
          sobrantes.push({ linea: porId.get(o.actual.id)!, unidades: o.unidades, precio: o.nueva ? o.nueva.salePrice : null })
          break
      }
    }

    if (sobrantes.length > 0) {
      await pasarAStockPropio(tx, { id, clientName: pedido.clientName }, sobrantes.map(s => ({ linea: s.linea, unidades: s.unidades })))
      // Lo que se quedó en el pedido con otro precio.
      for (const s of sobrantes) {
        if (s.precio != null && s.unidades < s.linea.quantity && Math.abs(s.precio - Number(s.linea.salePrice)) >= 0.005) {
          await tx.pedidoItem.update({ where: { id: s.linea.id }, data: { salePrice: s.precio } })
        }
      }
    }

    await tx.pedido.update({ where: { id }, data: { notas } })
    const detalle = describirOps(plan.ops)
    if (detalle.length > 0) await registrarEvento(tx, id, 'editado', detalle.join('\n'))
  }, { maxWait: 10_000, timeout: 20_000 })

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidatePath('/envios')
  revalidatePath('/inventario')
  revalidatePath('/contabilidad')
  revalidatePath('/resultados')
  revalidateClientes()
  redirect(`/presupuestos/${id}`)
}

// Los Bs de un adelanto, en la forma que espera Movimiento: dólares BCV × tasa, o nada.
// Si es todo el cobro se guardan los Bs que se escribieron, tal cual; en una corrección el monto
// escrito no es el delta y los Bs se calculan con la misma tasa.
function bsDelAdelanto(metodo: string | null, bcv: number, cobro: CobroEnBs | null, esTodo: boolean) {
  const bs = cobro ? datosBs(metodo, bcv, cobro.tasaBs, esTodo ? cobro.montoBs : null) : null
  return { montoBs: bs?.montoBs ?? null, tasaBs: bs?.tasaBs ?? null }
}

// Aprueba un presupuesto (status -> 'pedido') registrando el adelanto: monto,
// método de pago y fecha. Reutilizable para editar el adelanto de un pedido ya
// confirmado (el status ya es 'pedido' y solo se actualizan los campos del adelanto).
//
// depositUsd es una CACHÉ de "total recibido hasta ahora" (ver Pedido en el schema) y el
// libro es la fuente de verdad: las dos tienen que moverse juntas.
//   · Un AUMENTO es plata que entró de verdad: crea un Movimiento por el delta, no por el
//     total.
//   · Una BAJA es la corrección de un dato (se cargó $1000 y era $100): no salió plata, así
//     que se corrige el libro sacando ese monto de los ingresos del pedido — si no, el
//     depósito bajaba pero el Movimiento de $1000 seguía sumando al saldo de caja, inflado
//     para siempre. Una devolución real al cliente es otro hecho: va como egreso aparte.
//
// Todo corre bajo el cerrojo de la fila del pedido y lee el depósito DENTRO de la
// transacción: la lectura de antes estaba afuera, y un cobro registrado entre medio hacía
// que el delta se calculara contra un número viejo. De paso, un doble envío de la misma
// edición ve el resultado del primero y no anota nada de más.
//
// Cobro a dólar BCV (lib/cobro-bcv.ts): al confirmar se congela el escalón de brecha del día
// en Pedido.brechaEscalonPct. El adelanto cobrado en Bs se escribe en dólares BCV y se guarda
// su valor real; uno en divisas se escribe y se guarda tal cual. Guardar el monto BCV como si
// fueran dólares reales inflaba la caja y dejaba el saldo del cliente corto en la brecha.
export async function aprobarPedido(id: number, formData: FormData): Promise<ActionResult> {
  const paymentMethod = (formData.get('paymentMethod') as string)?.trim() || null
  // Cobrado en Bs se escribe en bolívares y tasa; los dólares salen de dividir (ver leerCobroBs).
  // Vacío = todavía no se cobró nada.
  const bs = leerCobroBs(formData, paymentMethod, true)
  if (!bs.ok) return fallo(bs.error)
  const rawDeposit = bs.cobro
    ? String(bs.cobro.montoUsd)
    : cobraEnBolivares(paymentMethod) ? '' : (formData.get('depositUsd') as string)?.trim()
  const rawDate = (formData.get('depositAt') as string)?.trim()
  // El input date da 'YYYY-MM-DD'; se ancla a mediodía para evitar corrimientos de zona horaria.
  const depositAt = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  // Vacío = "no se cobró nada"; un número ilegible o negativo no es ninguna de las dos cosas
  // y se rechaza en vez de guardarse como null.
  let montoEscrito: number | null = null
  if (rawDeposit) {
    const v = parseFloat(rawDeposit)
    if (!Number.isFinite(v) || v < 0) return fallo('El adelanto tiene que ser un monto válido (0 o más).')
    montoEscrito = v
  }
  const enBs = cobraEnBolivares(paymentMethod)
  const cfg = toConfigMap(await db.config.findMany())

  const resultado = await db.$transaction(async (tx): Promise<ActionResult> => {
    const actual = await bloquearPedido(tx, id)
    if (!actual) return fallo(`El pedido #${id} no existe.`)
    if (actual.status === 'cancelado') return fallo('Este pedido está cancelado: no se le puede registrar un adelanto.')
    const eraPresupuesto = actual.status === 'presupuesto'
    const ctx = await lineasYEscalon(tx, id)

    // Confirmar compromete precios y tasa: antes de aceptarlo se revalida lo que pudo cambiar desde
    // que se cotizó. (Editar el adelanto de un pedido ya confirmado no pasa por acá.)
    if (eraPresupuesto && ctx.tipo === 'cliente') {
      const vencido = motivoNoAprobable(estadoValidez(ctx.fechas, validezDias(cfg)))
      if (vencido) return fallo(vencido)
      // Una pieza que Bajaj dejó de fabricar DESPUÉS de cotizar: se prometería algo que nadie vende.
      try {
        await bloquearDescontinuadas(ctx.refs)
      } catch (e) {
        if (e instanceof ErrorDeNegocio) return fallo(e.message)
        throw e
      }
    }

    // Al confirmar se congela el escalón con el que se le presentó el presupuesto al cliente (el del
    // PDF que vio, no el del día en que se aprueba): es el total BCV que aceptó. Después ya no se
    // toca, aunque se edite el adelanto. Un presupuesto anterior a esto, sin escalón guardado, usa el de hoy.
    const escalon = eraPresupuesto
      ? (ctx.tipo === 'cliente' ? escalonDelPresupuesto(ctx.escalonCotizado, escalonBcvVigente(cfg)) : null)
      : ctx.escalon
    // El monto escrito es BCV si se cobró en Bs y en divisas si no; lo guardado, siempre real.
    const total = resumenCobro(ctx.lineas, 0, escalon)
    const nuevoDeposito =
      montoEscrito == null
        ? null
        : realDeCobro(montoEscrito, enBs, total, { bcv: total.totalBcv, real: total.totalReal })

    const anterior = actual.depositUsd
    // Dejar el campo vacío en un pedido que ya cobró borraría el depósito sin tocar el libro
    // (o, ahora, vaciaría los ingresos). Casi siempre es un descuido: para dejarlo en cero se
    // escribe 0.
    if (nuevoDeposito == null && anterior > 0.01) {
      return fallo(`Este pedido ya tiene $${anterior.toFixed(2)} cobrados. Si querés dejarlo en cero, escribí 0.`)
    }

    const delta = (nuevoDeposito ?? 0) - anterior

    await tx.pedido.update({
      where: { id },
      data: {
        status: 'pedido',
        depositUsd: nuevoDeposito,
        paymentMethod,
        depositAt,
        ...(eraPresupuesto ? { brechaEscalonPct: escalon } : {}),
      },
    })
    if (delta > 0.01) {
      await tx.movimiento.create({
        data: {
          fecha: depositAt,
          tipo: 'ingreso',
          categoria: eraPresupuesto ? 'adelanto_cliente' : 'pago_cliente',
          monto: delta,
          metodoPago: paymentMethod,
          cuenta: cuentaDeMetodo(paymentMethod),
          // Los Bs que entraron: el delta en dólares BCV (monto real ÷ factor) por la tasa.
          ...bsDelAdelanto(paymentMethod, delta / total.factor, bs.cobro, anterior < 0.01),
          // Solo cuando es todo el cobro: en una corrección el monto escrito no es el delta.
          descripcion: anterior < 0.01 ? notaCobroBcv(montoEscrito ?? 0, enBs, escalon) : null,
          pedidoId: id,
        },
      })
    } else if (delta < -0.01) {
      await descontarIngresosPedido(tx, id, -delta)
    }
    if (eraPresupuesto && ctx.tipo === 'cliente') {
      await registrarEvento(
        tx, id, 'confirmado',
        `Confirmado con adelanto de $${(nuevoDeposito ?? 0).toFixed(2)}` + (escalon != null ? ` · escalón BCV ${escalon}%` : ''),
      )
    }
    return ok()
  }, { maxWait: 10_000, timeout: 20_000 })

  if (!resultado.ok) return resultado

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidatePath('/contabilidad')
  // El adelanto y el pase a 'pedido' mueven los totales del cliente.
  revalidateClientes()
  return ok()
}

// Anota un pago adicional (liquidación, cuota) sin tocar el status ni el método/fecha del
// adelanto original. Mismo mecanismo que el delta de aprobarPedido: suma a la caché
// depositUsd y deja un Movimiento por el monto exacto que entró (ver registrarIngresoPedido,
// que suma con un UPDATE atómico y no leyendo el depósito para reescribirlo).
//
// En un pedido a dólar BCV el monto cobrado en Bs se escribe en dólares BCV y se guarda su
// valor real; el saldo se lee bajo el cerrojo del pedido, porque un pago que lo cubre se
// guarda como el saldo real exacto (ver realDeCobro).
export async function registrarPagoPedido(pedidoId: number, formData: FormData): Promise<ActionResult> {
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const bs = leerCobroBs(formData, metodoPago)
  if (!bs.ok) return fallo(bs.error)
  const monto = bs.cobro ? bs.cobro.montoUsd : parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  let resultado: ActionResult
  try {
    resultado = await db.$transaction(
      tx => cobrarPedido(tx, { pedidoId, monto, categoria: 'pago_cliente', fecha, metodoPago, descripcion, tasaBs: bs.cobro?.tasaBs, montoBs: bs.cobro?.montoBs }),
      { maxWait: 10_000, timeout: 20_000 },
    )
  } catch (e) {
    // El pedido se borró desde otra pestaña: el movimiento no tiene a quién colgarse.
    if (isForeignKeyViolation(e)) return fallo('Ese pedido ya no existe. Recargá la página.')
    throw e
  }
  if (!resultado.ok) return resultado

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${pedidoId}`)
  revalidatePath('/contabilidad')
  revalidateClientes()
  return ok()
}

// Solo se borra lo que nunca tuvo consecuencias (ver motivoNoEliminable): un pedido con
// cobros, compras o piezas en una caja dejaría el libro y las cajas con huecos. La
// pantalla ya no ofrece el botón en esos casos; este es el cerrojo del lado del server, y
// devuelve el motivo (`DeleteButton` lo muestra) en vez de tirarlo: en producción un throw
// llega sin el texto.
export async function deletePresupuesto(id: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => borrarPresupuesto(id))
  if (!r.ok) return r
  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect('/presupuestos')
}

async function borrarPresupuesto(id: number) {
  await db.$transaction(async tx => {
    const p = await tx.pedido.findUnique({
      where: { id },
      select: {
        tipo: true,
        status: true,
        depositUsd: true,
        items: { select: { envioId: true, shippingStatus: true, costRealUsd: true } },
        _count: { select: { movimientos: true } },
      },
    })
    if (!p) return // ya lo había borrado otra request

    const motivo = motivoNoEliminable({ ...p, movimientos: p._count.movimientos })
    if (motivo) throw new ErrorDeNegocio(`No se puede borrar: ${motivo}`)

    await tx.pedido.delete({ where: { id } })
  })
}
