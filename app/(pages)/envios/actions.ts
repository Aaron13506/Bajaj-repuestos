'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isValidStatus, normalizeToRoute, routeFor } from '@/lib/shipping-status'

export async function createEnvio(formData: FormData) {
  const nombre = (formData.get('nombre') as string)?.trim() || null
  const notas = (formData.get('notas') as string)?.trim() || null

  const envio = await db.envio.create({ data: { nombre, notas } })

  revalidatePath('/envios')
  redirect(`/envios/${envio.id}`)
}

// El PRESUPUESTO es la unidad que entra y sale de un envío, no el ítem suelto: es lo que
// se le vendió al cliente y no se parte. Sus ítems siguen teniendo envioId propio (así el
// estado de transporte puede diferir entre piezas), pero se asignan y se liberan todos
// juntos. Por eso no hay acciones por ítem acá.
export async function assignPedido(envioId: number, pedidoId: number) {
  await db.pedidoItem.updateMany({
    where: { pedidoId, envioId: null },
    data: { envioId },
  })
  revalidatePath(`/envios/${envioId}`)
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

  await db.pedidoItem.updateMany({
    where: {
      envioId: null,
      pedido: {
        status: 'pedido',
        ...(incluirPropio ? {} : { tipo: { not: 'propio' } }),
      },
    },
    data: { envioId },
  })

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

// Costo real facturado del tramo China → USA. Sin esto los ítems chinos viajan
// gratis en el cálculo y el envío queda subcosteado.
export async function saveInboundChina(envioId: number, formData: FormData) {
  const raw = (formData.get('inboundChinaUsd') as string)?.trim()
  const parsed = raw ? parseFloat(raw.replace(',', '.')) : NaN

  await db.envio.update({
    where: { id: envioId },
    data: { inboundChinaUsd: Number.isFinite(parsed) && parsed >= 0 ? parsed : null },
  })
  revalidatePath(`/envios/${envioId}`)
}

// Resuelve el origen y el isLanded que le corresponden a un ítem según el proveedor
// elegido. El origen es un hecho del proveedor; isLanded sale de la fila explícita de
// SupplierPrice para ese (proveedor, producto) y NUNCA se infiere de un monto.
async function datosDeProveedor(pares: { productId: number; supplierId: number | null }[]) {
  const supplierIds = [...new Set(pares.map(p => p.supplierId).filter((v): v is number => v != null))]
  if (supplierIds.length === 0) return { origenPorSupplier: new Map<number, string>(), landed: new Set<string>() }

  const [suppliers, precios] = await Promise.all([
    db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, origen: true } }),
    db.supplierPrice.findMany({
      where: { supplierId: { in: supplierIds }, productId: { in: pares.map(p => p.productId) }, isLanded: true },
      select: { supplierId: true, productId: true },
    }),
  ])
  return {
    origenPorSupplier: new Map(suppliers.map(s => [s.id, s.origen])),
    landed: new Set(precios.map(p => `${p.supplierId}:${p.productId}`)),
  }
}

export interface CambioItem {
  id: number
  shippingStatus: string
  supplierId: number | null
}

// Guarda en LOTE el estado y el proveedor de los ítems del envío.
//
// La llama la tabla (client component) con los cambios ya calculados: sirve igual para un
// select suelto que para "aplicar a todo el presupuesto", porque en los dos casos el
// cliente sabe exactamente qué filas cambió. Un solo viaje a la DB por tanda.
//
// Se parte de los ítems que REALMENTE están en este envío y se compara contra lo que hay
// en la DB: así un id ajeno no puede tocar nada, y no se pisa shippingStatusAt de los que
// no cambiaron. Cambiar el proveedor recalcula la ruta y el estado se normaliza a ella —
// un ítem de China no puede quedar "en Shoppre".
export async function saveItemChanges(envioId: number, cambios: CambioItem[]) {
  if (cambios.length === 0) return

  const items = await db.pedidoItem.findMany({
    where: { envioId, id: { in: cambios.map(c => c.id) } },
    select: { id: true, productId: true, shippingStatus: true, supplierId: true, origen: true, isLanded: true },
  })
  if (items.length === 0) return

  const pedido = new Map(cambios.map(c => [c.id, c]))
  const { origenPorSupplier, landed } = await datosDeProveedor(
    items.map(it => ({ productId: it.productId, supplierId: pedido.get(it.id)?.supplierId ?? it.supplierId }))
  )

  const now = new Date()
  const updates = items.flatMap(it => {
    const c = pedido.get(it.id)
    if (!c) return []

    const supplierId = c.supplierId
    const origen = supplierId != null ? (origenPorSupplier.get(supplierId) ?? 'india') : 'india'
    const isLanded = supplierId != null && landed.has(`${supplierId}:${it.productId}`)
    const destino = isValidStatus(c.shippingStatus) ? c.shippingStatus : it.shippingStatus
    const status = normalizeToRoute(destino, routeFor(origen, isLanded))

    const cambiaEstado = status !== it.shippingStatus
    const cambiaProveedor = supplierId !== it.supplierId || origen !== it.origen || isLanded !== it.isLanded
    if (!cambiaEstado && !cambiaProveedor) return []

    return [
      db.pedidoItem.update({
        where: { id: it.id },
        data: {
          supplierId,
          origen,
          isLanded,
          shippingStatus: status,
          ...(cambiaEstado ? { shippingStatusAt: now } : {}),
          // La fecha de compra se sella la primera vez que el ítem deja de estar pendiente,
          // y se borra si vuelve a pendiente.
          ...(cambiaEstado && status !== 'pendiente' && it.shippingStatus === 'pendiente'
            ? { compradoAt: now }
            : {}),
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
