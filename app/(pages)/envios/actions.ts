'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isValidStatus, normalizeToRoute, routeFor } from '@/lib/shipping-status'
import { inboundDe } from '@/lib/inbound'
import { isModoApp } from '@/lib/modo'

// Crea una caja. La RUTA se elige acá y no se vuelve a tocar: es lo que decide con qué
// cadena logística se costea y, sobre todo, qué se puede meter adentro.
//
//   aéreo    → nace confirmado y se llena asignándole PEDIDOS (carga comercial).
//   marítimo → nace en BORRADOR y se llena pieza por pieza con mercancía propia.
export async function createEnvio(formData: FormData) {
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

  const envio = await db.envio.create({ data: { nombre, notas, modo, estado, supplierId } })

  revalidatePath('/envios')
  redirect(`/envios/${envio.id}`)
}

// El PRESUPUESTO es la unidad que entra y sale de un envío, no el ítem suelto: es lo que
// se le vendió al cliente y no se parte. Sus ítems siguen teniendo envioId propio (así el
// estado de transporte puede diferir entre piezas), pero se asignan y se liberan todos
// juntos. Por eso no hay acciones por ítem acá.
export async function assignPedido(envioId: number, pedidoId: number) {
  const ids = await db.pedidoItem.findMany({
    where: { pedidoId, envioId: null },
    select: { id: true },
  })
  await asignarAEnvio(envioId, ids.map(i => i.id))
  revalidatePath(`/envios/${envioId}`)
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
async function asignarAEnvio(envioId: number, itemIds: number[]) {
  if (itemIds.length === 0) return

  const [envio, items] = await Promise.all([
    db.envio.findUnique({
      where: { id: envioId },
      select: { supplier: { select: { id: true, origen: true, inbound: true } } },
    }),
    db.pedidoItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, productId: true, shippingStatus: true },
    }),
  ])

  const sup = envio?.supplier ?? null
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
}

export async function removePedido(envioId: number, pedidoId: number) {
  await db.pedidoItem.updateMany({ where: { pedidoId, envioId }, data: { envioId: null } })
  revalidatePath(`/envios/${envioId}`)
}

// Asigna de un tirón los ítems sin envío de todos los pedidos CONFIRMADOS
// (status='pedido'). Nunca toca presupuestos sin aprobar. El stock propio
// (tipo='propio') también tiene status='pedido' desde que se crea, así que se filtra
// aparte según el checkbox del formulario.
export async function assignAllConfirmados(envioId: number, formData: FormData) {
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
  await asignarAEnvio(envioId, ids.map(i => i.id))

  revalidatePath(`/envios/${envioId}`)
}

// Persiste el costo de flete estimado (tramos a USA + marítimo) calculado en la ficha.
export async function saveEstimate(envioId: number, shippingCostEst: number) {
  await db.envio.update({
    where: { id: envioId },
    data: { shippingCostEst },
  })
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
}

// La caja como la pesó y midió el transportista, más lo que terminó facturando.
//
// Es el único dato del envío que NO se puede derivar del catálogo: el catálogo conoce la
// pieza desnuda y la balanza pesa el bulto — cada repuesto con su caja, el cartón y el
// relleno. Mientras no esté cargado, el costeo de la caja es un piso.
//
// Cada campo se guarda por separado y vacío significa "todavía no lo sé", no cero: cargar
// el peso no inventa las medidas, y un 0 haría desaparecer la caja del cálculo.
export async function saveMedidasCaja(envioId: number, formData: FormData) {
  const num = (name: string) => {
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) return null
    const v = parseFloat(raw.replace(',', '.'))
    return Number.isFinite(v) && v > 0 ? v : null
  }

  await db.envio.update({
    where: { id: envioId },
    data: {
      pesoRealKg: num('pesoRealKg'),
      cajaL: num('cajaL'),
      cajaA: num('cajaA'),
      cajaH: num('cajaH'),
      shippingCostReal: num('shippingCostReal'),
    },
  })
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
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
export async function saveCostosProveedor(envioId: number, formData: FormData) {
  // Un campo AUSENTE del formulario devuelve undefined y Prisma no lo toca; uno presente
  // pero vacío devuelve null y borra lo que hubiera. La diferencia importa porque las dos
  // rutas usan esta misma acción con formularios distintos: el marítimo no pregunta por el
  // tramo a USA (no existe), y sin esta distinción guardarlo desde ahí lo borraría.
  const num = (name: string) => {
    if (!formData.has(name)) return undefined
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) return null
    const v = parseFloat(raw.replace(',', '.'))
    return Number.isFinite(v) && v >= 0 ? v : null
  }

  await db.envio.update({
    where: { id: envioId },
    data: {
      tramoUsd: num('tramoUsd'),
      // Cada punta del giro se guarda aparte: se conocen en momentos distintos y un vacío
      // sigue significando "no lo sé", no cero.
      comisionSalienteUsd: num('comisionSalienteUsd'),
      comisionEntranteUsd: num('comisionEntranteUsd'),
    },
  })
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
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
    select: { id: true, shippingStatus: true, origen: true, inbound: true, isLanded: true },
  })
  if (items.length === 0) return

  const pedido = new Map(cambios.map(c => [c.id, c]))
  const now = new Date()

  const updates = items.flatMap(it => {
    const c = pedido.get(it.id)
    if (!c) return []

    const destino = isValidStatus(c.shippingStatus) ? c.shippingStatus : it.shippingStatus
    const ruta = routeFor(inboundDe(it.origen, it.inbound), it.isLanded)
    const status = normalizeToRoute(destino, ruta)
    if (status === it.shippingStatus) return []

    return [
      db.pedidoItem.update({
        where: { id: it.id },
        data: {
          shippingStatus: status,
          shippingStatusAt: now,
          // La fecha de compra se sella la primera vez que el ítem deja de estar pendiente,
          // y se borra si vuelve a pendiente.
          ...(status !== 'pendiente' && it.shippingStatus === 'pendiente' ? { compradoAt: now } : {}),
          ...(status === 'pendiente' ? { compradoAt: null } : {}),
        },
      }),
    ]
  })

  if (updates.length) await db.$transaction(updates)
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
}

export async function deleteEnvio(id: number) {
  // Los ítems quedan liberados (envioId -> null) por onDelete: SetNull.
  await db.envio.delete({ where: { id } })
  revalidatePath('/envios')
  redirect('/envios')
}
