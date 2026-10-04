'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isDelivered, isValidStatus, normalizeToRoute, routeFor } from '@/lib/shipping-status'
import { inboundDe } from '@/lib/inbound'
import { isModoApp } from '@/lib/modo'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { isForeignKeyViolation } from '@/lib/prisma-errors'
import { CATEGORIAS_EGRESO } from '@/lib/movimientos'

// Crea una caja. La RUTA se elige acá y no se vuelve a tocar: es lo que decide con qué
// cadena logística se costea y, sobre todo, qué se puede meter adentro.
//
//   aéreo    → nace confirmado y se llena asignándole PEDIDOS (carga comercial).
//   marítimo → nace en BORRADOR y se llena pieza por pieza con mercancía propia.
export async function createEnvio(formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim() || null
  const notas = (formData.get('notas') as string)?.trim() || null
  const raw = formData.get('modo') as string
  const modo = isModoApp(raw) ? raw : 'aereo'
  const estado = modo === 'maritimo_cbm' ? 'borrador' : 'confirmado'

  // El proveedor se elige acá, en las DOS rutas, y ya no se toca. Antes solo se preguntaba
  // en el marítimo porque por aire se le compraba siempre a 99rpm; dejó de ser cierto
  // cuando empezaron a convivir una caja de Shoppre y una de Garuda viajando en paralelo.
  //
  // Se congela al crear porque decide todo lo demás: el precio de cada pieza, si el tramo a
  // USA lo cobra la tabla escalón o lo factura el proveedor, qué etapas tiene la ruta, y el
  // FOB en el marítimo. Vacío = 99rpm, el precio base en ₹.
  const supplierRaw = parseInt((formData.get('supplierId') as string) ?? '')
  const supplierId = Number.isFinite(supplierRaw) ? supplierRaw : null

  let envio
  try {
    envio = await db.envio.create({ data: { nombre, notas, modo, estado, supplierId } })
  } catch (e) {
    // El proveedor se borró desde otra pestaña después de armar el selector.
    if (isForeignKeyViolation(e)) return fallo('Ese proveedor ya no existe. Recargá la página.')
    throw e
  }

  revalidatePath('/envios')
  redirect(`/envios/${envio.id}`)
}

// El PRESUPUESTO es la unidad NORMAL que entra a un envío: es lo que se le vendió al
// cliente y lo habitual es traerlo entero. Pero no es la unidad obligatoria — la unidad
// real de compra y logística es el PedidoItem (por eso tiene envioId propio), y un
// presupuesto se compra a medias todo el tiempo: unas piezas entran en la caja que sale
// esta semana y el resto espera a la próxima.
//
// Por eso hay dos puertas: esta, que mete todo el presupuesto, y `assignItems`, que mete
// las líneas elegidas. La de acá sigue siendo la primaria y la que ofrecen los botones.
//
// Mete solo lo que está LIBRE (`envioId: null`). Un presupuesto ya repartido entre cajas
// no se muda entero al agregarlo a una nueva: se le suma únicamente lo que todavía no
// viaja en ninguna, que es lo que falta por traer.
export async function assignPedido(envioId: number, pedidoId: number): Promise<ActionResult> {
  const ids = await db.pedidoItem.findMany({
    where: { pedidoId, envioId: null },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, ids.map(i => i.id))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// Mete en la caja SOLO las líneas elegidas: la alternativa a traer el presupuesto entero,
// para cuando se parte entre dos envíos.
//
// Vuelve a filtrar por `envioId: null` en vez de confiar en los ids que llegan. La pantalla
// desde la que se eligió pudo quedar vieja —otra caja se llevó esa línea mientras tanto— y
// sin el filtro este asigna igual, robándosela a un envío que quizá ya viajó. Es la misma
// razón por la que `assignPedido` filtra: lo asignable es lo que está libre AHORA.
export async function assignItems(envioId: number, itemIds: number[]): Promise<ActionResult> {
  const ids = itemIds.filter(Number.isInteger)
  if (ids.length === 0) return ok()
  const libres = await db.pedidoItem.findMany({
    where: { id: { in: ids }, envioId: null },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, libres.map(i => i.id))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// Saca líneas sueltas de la caja. El contrapeso de `assignItems`: si el reparto entre dos
// envíos salió mal, se corrige la línea que sobra y no el presupuesto entero.
//
// Acotado a `envioId` para que no pueda liberar lo que viaja en otra caja.
export async function removeItems(envioId: number, itemIds: number[]) {
  const ids = itemIds.filter(Number.isInteger)
  if (ids.length === 0) return
  await db.pedidoItem.updateMany({
    where: { id: { in: ids }, envioId },
    data: { envioId: null },
  })
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
}

// Mete líneas en una caja y les copia el proveedor de ESA caja.
//
// La caja es la compra: se le compró a alguien, y todo lo que va adentro se le compró a
// esa misma persona. Antes el proveedor se elegía línea por línea en la tabla, y eso
// permitía el estado imposible de una caja de Garuda con una línea marcada Shoppre — que
// además costeaba mal en silencio, porque esa línea buscaba una tarifa por kilo que para
// esa caja no existe.
//
// De paso se recalcula la ruta: un ítem que estaba "en Shoppre" y pasa a una caja que
// despacha directo se normaliza a la etapa equivalente de su nueva ruta, nunca hacia atrás.
//
// Antes de asignar se valida la caja: ninguna de las tres puertas lo hacía, y con un id viejo
// (una pestaña que quedó abierta) se podía colgar un PedidoItem de una caja marítima —que no
// muestra `items`, así que la línea desaparecía de la vista— o de una ya entregada, y con un
// id que ya no existe saltaba un error de FK sin explicación. Devuelve el motivo en vez de
// tirarlo, porque en producción un throw llega sin texto.
async function asignarAEnvio(envioId: number, itemIds: number[]): Promise<ActionResult> {
  if (itemIds.length === 0) return ok()

  const [envio, items] = await Promise.all([
    db.envio.findUnique({
      where: { id: envioId },
      select: { modo: true, estado: true, supplier: { select: { id: true, origen: true, inbound: true } } },
    }),
    db.pedidoItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, productId: true, shippingStatus: true },
    }),
  ])

  if (!envio) return fallo(`La caja #${envioId} ya no existe.`)
  if (envio.modo !== 'aereo') {
    return fallo('Esa caja es marítima: lleva mercancía propia pieza por pieza, no pedidos.')
  }
  if (envio.estado === 'entregado') {
    return fallo('Esa caja ya se entregó: no se le pueden agregar pedidos.')
  }

  const sup = envio.supplier
  const origen = sup?.origen ?? 'india'
  const inbound = inboundDe(origen, sup?.inbound)

  // isLanded no sale del proveedor sino de la fila explícita (proveedor, producto): el
  // mismo proveedor puede cotizar unas piezas puestas en Venezuela y otras no.
  const landed = sup
    ? new Set(
        (await db.supplierPrice.findMany({
          where: { supplierId: sup.id, productId: { in: items.map(i => i.productId) }, isLanded: true },
          select: { productId: true },
        })).map(r => r.productId),
      )
    : new Set<number>()

  await db.$transaction(items.map(it => {
    const esLanded = landed.has(it.productId)
    return db.pedidoItem.update({
      where: { id: it.id },
      data: {
        envioId,
        supplierId: sup?.id ?? null,
        origen,
        inbound,
        isLanded: esLanded,
        shippingStatus: normalizeToRoute(it.shippingStatus, routeFor(inbound, esLanded)),
      },
    })
  }))
  return ok()
}

export async function removePedido(envioId: number, pedidoId: number) {
  await db.pedidoItem.updateMany({ where: { pedidoId, envioId }, data: { envioId: null } })
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
}

// Asigna de un tirón los ítems sin envío de todos los pedidos CONFIRMADOS
// (status='pedido'). Nunca toca presupuestos sin aprobar. El stock propio
// (tipo='propio') también tiene status='pedido' desde que se crea, así que se filtra
// aparte según el checkbox del formulario.
export async function assignAllConfirmados(envioId: number, formData: FormData): Promise<ActionResult> {
  const incluirPropio = formData.get('incluirPropio') === 'on'

  const ids = await db.pedidoItem.findMany({
    where: {
      envioId: null,
      pedido: {
        status: 'pedido',
        ...(incluirPropio ? {} : { tipo: { not: 'propio' } }),
      },
    },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, ids.map(i => i.id))

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// La caja como la pesó y midió el transportista, más lo que terminó facturando.
//
// Es el único dato del envío que NO se puede derivar del catálogo: el catálogo conoce la
// pieza desnuda y la balanza pesa el bulto — cada repuesto con su caja, el cartón y el
// relleno. Mientras no esté cargado, el costeo de la caja es un piso.
//
// Cada campo se guarda por separado y vacío significa "todavía no lo sé", no cero: cargar
// el peso no inventa las medidas, y un 0 haría desaparecer la caja del cálculo.
//
// Un número ilegible o negativo se RECHAZA en vez de guardarse como vacío: vacío es "no lo
// sé" y reemplaza lo que hubiera, así que tipear mal "18,6x" borraba en silencio el peso ya
// cargado y la pantalla volvía a la estimación como si nada. Vacío y 0 siguen siendo "sin dato".
export async function saveMedidasCaja(envioId: number, formData: FormData): Promise<ActionResult> {
  const campos = {
    pesoRealKg: 'el peso real',
    cajaL: 'el largo de la caja',
    cajaA: 'el ancho de la caja',
    cajaH: 'el alto de la caja',
    shippingCostRealAereo: 'el flete aéreo',
    shippingCostRealMaritimo: 'el flete marítimo',
  } as const
  const data: Record<keyof typeof campos, number | null> = {
    pesoRealKg: null, cajaL: null, cajaA: null, cajaH: null,
    shippingCostRealAereo: null, shippingCostRealMaritimo: null,
  }
  for (const [name, nombre] of Object.entries(campos) as [keyof typeof campos, string][]) {
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) continue
    const v = parseFloat(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) return fallo(`Revisá ${nombre}: no es un número válido.`)
    data[name] = v > 0 ? v : null
  }

  const r = await db.envio.updateMany({ where: { id: envioId }, data })
  if (r.count === 0) return fallo('Ese envío ya no existe.')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Lo que se le pagó al proveedor de esta caja, aparte de la mercancía: el total que
// facturó por llevarla hasta USA (solo si despacha él, o sea 'cotizado') y lo que costó la
// transferencia con la que se le giró.
//
// Ninguno de los dos se puede derivar. El primero porque el proveedor no tiene tabla de
// tarifas — que es justamente lo que significa 'cotizado' — y sin él sus piezas viajan
// gratis en el cálculo. El segundo porque la comisión no es un rasgo del proveedor sino de
// cada giro: cambia con el monto y con el banco del otro lado, y a la mayoría ni se le
// transfiere. Por eso se anota, no se calcula.
//
// Vacío es "no lo sé todavía" y se guarda como null; un 0 escrito a mano SÍ es un dato
// ("ese giro no costó nada") y se respeta. Las pantallas distinguen los dos casos.
export async function saveCostosProveedor(envioId: number, formData: FormData): Promise<ActionResult> {
  // Un campo AUSENTE del formulario devuelve undefined y Prisma no lo toca; uno presente
  // pero vacío devuelve null y borra lo que hubiera. La diferencia importa porque las dos
  // rutas usan esta misma acción con formularios distintos: el marítimo no pregunta por el
  // tramo a USA (no existe), y sin esta distinción guardarlo desde ahí lo borraría.
  //
  // Un número ilegible o negativo se rechaza: guardarlo como vacío (lo que se hacía) borraba
  // en silencio un monto ya cargado, y en este modelo vacío es "no lo sé", no un error de tipeo.
  const campos = [
    ['tramoUsd', 'el envío + impuestos'],
    ['comisionSalienteUsd', 'la comisión saliente'],
    ['comisionEntranteUsd', 'la comisión entrante'],
  ] as const
  const data: Partial<Record<(typeof campos)[number][0], number | null>> = {}
  for (const [name, nombre] of campos) {
    if (!formData.has(name)) continue
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) { data[name] = null; continue }
    const v = parseFloat(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) return fallo(`Revisá ${nombre}: no es un número válido.`)
    data[name] = v
  }

  // Cada punta del giro se guarda aparte: se conocen en momentos distintos y un vacío sigue
  // significando "no lo sé", no cero.
  const r = await db.envio.updateMany({ where: { id: envioId }, data })
  if (r.count === 0) return fallo('Ese envío ya no existe.')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Anota un egreso real (plata que salió de la cuenta) contra esta caja: pago de
// mercancía, comisión de giro, flete. Es aditivo — no toca tramoUsd/comisionSalienteUsd/
// comisionEntranteUsd (esos son lo FACTURADO, se siguen cargando aparte con
// saveCostosProveedor). "Pagado"/"pendiente" de este envío se calculan en vivo sumando
// estos movimientos (ver lib/movimientos.ts: cuentasPorPagar).
export async function registrarPagoProveedor(envioId: number, formData: FormData): Promise<ActionResult> {
  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')
  const categoria = (formData.get('categoria') as string)?.trim() || 'pago_proveedor'
  // Esto siempre es un egreso: una categoría de ingreso (o inventada) desde un POST armado
  // quedaría anotada como egreso con un nombre que no le corresponde.
  if (!(CATEGORIAS_EGRESO as readonly string[]).includes(categoria)) return fallo('Esa categoría no es un egreso.')
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  const envio = await db.envio.findUnique({ where: { id: envioId }, select: { supplierId: true } })
  if (!envio) return fallo('Ese envío ya no existe.')

  await db.movimiento.create({
    data: { fecha, tipo: 'egreso', categoria, monto, metodoPago, descripcion, envioId, supplierId: envio.supplierId },
  })

  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/contabilidad')
  return ok()
}

export interface CambioItem {
  id: number
  shippingStatus: string
}

// Guarda en LOTE el estado de transporte de los ítems del envío.
//
// La llama la tabla (client component) con los cambios ya calculados: sirve igual para un
// select suelto que para "aplicar a todo el presupuesto", porque en los dos casos el
// cliente sabe exactamente qué filas cambió. Un solo viaje a la DB por tanda.
//
// El PROVEEDOR ya no se toca acá: es de la caja, y las líneas lo heredaron al entrar (ver
// asignarAEnvio). Cuando se elegía por línea, una caja de Garuda podía tener una línea
// marcada Shoppre — un estado imposible que además costeaba mal sin avisar.
//
// Se parte de los ítems que REALMENTE están en este envío, así un id ajeno no puede tocar
// nada, y el estado se normaliza a la ruta de cada uno: un ítem que despacha el proveedor
// no puede quedar "en Shoppre".
export async function saveItemChanges(envioId: number, cambios: CambioItem[]) {
  if (cambios.length === 0) return

  const items = await db.pedidoItem.findMany({
    where: { envioId, id: { in: cambios.map(c => c.id) } },
    select: {
      id: true, shippingStatus: true, origen: true, inbound: true, isLanded: true,
      productId: true, quantity: true, pedido: { select: { tipo: true } },
    },
  })
  if (items.length === 0) return

  const pedido = new Map(cambios.map(c => [c.id, c]))
  let tocaStock = false

  // Cada fila lleva el estado que LEYÓ (`desde`) y el que quiere (`hacia`). El UPDATE solo
  // toca la fila si sigue en `desde`: si dos requests llevan la misma línea a 'entregado'
  // (doble tanda, dos pestañas), la segunda espera el candado de la fila, la encuentra ya
  // movida y no actualiza nada — y con ella no se acredita el stock por segunda vez.
  const filas: { id: number; desde: string; hacia: string; delta: number }[] = []
  for (const it of items) {
    const c = pedido.get(it.id)
    if (!c) continue

    const destino = isValidStatus(c.shippingStatus) ? c.shippingStatus : it.shippingStatus
    const ruta = routeFor(inboundDe(it.origen, it.inbound), it.isLanded)
    const status = normalizeToRoute(destino, ruta)
    if (status === it.shippingStatus) continue

    // Stock propio: lo comercial (tipo='cliente') se entrega a un cliente, nunca pasa a
    // ser stock. El delta sigue la TRANSICIÓN de "entregado" (no un flag aparte guardado en
    // otro lado), así que ida y vuelta del estado nunca duplica ni pierde el crédito: si el
    // ítem ya estaba entregado antes de este cambio, ya se sumó, y si deja de estarlo hay
    // que restarlo.
    let delta = 0
    if (it.pedido.tipo === 'propio') {
      const eraEntregado = isDelivered(it.shippingStatus)
      const quedaEntregado = isDelivered(status)
      if (eraEntregado !== quedaEntregado) delta = quedaEntregado ? it.quantity : -it.quantity
    }
    if (delta !== 0) tocaStock = true
    filas.push({ id: it.id, desde: it.shippingStatus, hacia: status, delta })
  }

  if (filas.length > 0) {
    // UNA sentencia: el cambio de estado y el ajuste de stock salen de las mismas filas
    // (las que de verdad se movieron, RETURNING), así que no puede haber una sin la otra ni
    // un stock sumado por una fila que otra request ya movió. La fecha de compra se sella
    // la primera vez que el ítem deja de estar pendiente, y se borra si vuelve a pendiente.
    // La hora se toma en la base, en UTC (así guarda Prisma los DateTime).
    const valores = Prisma.join(
      filas.map(f => Prisma.sql`(${f.id}::int, ${f.desde}::text, ${f.hacia}::text, ${f.delta}::int)`),
    )
    await db.$executeRaw`
      WITH v(id, desde, hacia, delta) AS (VALUES ${valores}),
      movidas AS (
        UPDATE "PedidoItem" AS pi
        SET "shippingStatus" = v.hacia,
            "shippingStatusAt" = (NOW() AT TIME ZONE 'UTC'),
            "compradoAt" = CASE
              WHEN v.hacia = 'pendiente' THEN NULL
              WHEN v.desde = 'pendiente' THEN (NOW() AT TIME ZONE 'UTC')
              ELSE pi."compradoAt"
            END
        FROM v
        WHERE pi."id" = v.id AND pi."envioId" = ${envioId} AND pi."shippingStatus" = v.desde
        RETURNING pi."productId", v.delta
      )
      UPDATE "Product" AS p
      SET "stock" = p."stock" + s.delta
      FROM (
        SELECT "productId", SUM(delta)::int AS delta FROM movidas WHERE delta <> 0 GROUP BY "productId"
      ) AS s
      WHERE p."id" = s."productId"`
  }

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  if (tocaStock) {
    revalidatePath('/contabilidad')
    revalidatePath('/products')
    revalidatePath('/')
  }
}

export async function deleteEnvio(id: number): Promise<ActionResult> {
  const envio = await db.envio.findUnique({
    where: { id },
    select: { estado: true, _count: { select: { movimientos: true } } },
  })
  // Ya no existe (otra pestaña, un reintento): lo que se quería ya está logrado.
  if (!envio) redirect('/envios')
  // Una caja 'entregado' ya sumó su contenido a Product.stock: borrarla sin deshacer esa
  // recepción (ver deshacerRecepcion) dejaría el stock arriba sin ningún registro que lo
  // explique. El botón ya se esconde en esa vista; esto es el mismo corte del lado server.
  if (envio.estado === 'entregado') return fallo('La caja ya se recibió: deshacé la recepción antes de borrarla.')
  // Con pagos registrados, borrarla dejaría esos movimientos sin caja (onDelete: SetNull) y
  // la deuda con el proveedor saldría de "cuentas por pagar" sin que nadie la haya saldado.
  if (envio._count.movimientos > 0) {
    return fallo(`Tiene ${envio._count.movimientos} movimiento${envio._count.movimientos === 1 ? '' : 's'} de caja registrado${envio._count.movimientos === 1 ? '' : 's'}: borrarla los dejaría sin caja.`)
  }

  // Los ítems quedan liberados (envioId -> null) por onDelete: SetNull.
  await db.envio.deleteMany({ where: { id } })
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  redirect('/envios')
}
