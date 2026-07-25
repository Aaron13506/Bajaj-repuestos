'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isValidStatus } from '@/lib/shipping-status'

export async function createEnvio(formData: FormData) {
  const nombre = (formData.get('nombre') as string)?.trim() || null
  const notas = (formData.get('notas') as string)?.trim() || null

  const envio = await db.envio.create({ data: { nombre, notas } })

  revalidatePath('/envios')
  redirect(`/envios/${envio.id}`)
}

export async function assignPedido(envioId: number, pedidoId: number) {
  await db.pedido.update({ where: { id: pedidoId }, data: { envioId } })
  revalidatePath(`/envios/${envioId}`)
}

// Asigna de un tirón todos los pedidos CONFIRMADOS (status='pedido') que aún no
// tienen envío. Nunca toca presupuestos sin aprobar. El stock propio (tipo='propio')
// también tiene status='pedido' desde que se crea, así que se filtra aparte según
// el checkbox del formulario.
export async function assignAllConfirmados(envioId: number, formData: FormData) {
  const incluirPropio = formData.get('incluirPropio') === 'on'

  await db.pedido.updateMany({
    where: {
      envioId: null,
      status: 'pedido',
      ...(incluirPropio ? {} : { tipo: { not: 'propio' } }),
    },
    data: { envioId },
  })

  revalidatePath(`/envios/${envioId}`)
}

export async function removePedido(envioId: number, pedidoId: number) {
  await db.pedido.update({ where: { id: pedidoId }, data: { envioId: null } })
  revalidatePath(`/envios/${envioId}`)
}

// Persiste el costo de flete estimado (aéreo + marítimo) calculado en la ficha.
export async function saveEstimate(envioId: number, shippingCostEst: number) {
  await db.envio.update({
    where: { id: envioId },
    data: { shippingCostEst },
  })
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
}

// Guarda en LOTE el estado de varios pedidos del envío. Un solo submit del formulario
// de la tabla: se escriben en una transacción solo los que cambiaron, así no se pisa
// shippingStatusAt de los que no tocaste. Cambiar 10 pedidos = 1 viaje a la DB.
//
// Se parte de los pedidos que REALMENTE están en este envío y se compara contra el
// estado que hay en la DB (no contra un input oculto del form): así un id ajeno en el
// submit no puede tocar nada, y un form viejo no revive un estado ya cambiado.
export async function saveShippingStatuses(envioId: number, formData: FormData) {
  const pedidos = await db.pedido.findMany({
    where: { envioId },
    select: { id: true, shippingStatus: true },
  })

  const now = new Date()
  const updates = pedidos.flatMap(p => {
    const status = formData.get(`status-${p.id}`)
    if (typeof status !== 'string' || !isValidStatus(status)) return []
    if (status === p.shippingStatus) return []
    return [
      db.pedido.update({
        where: { id: p.id },
        data: { shippingStatus: status, shippingStatusAt: now },
      }),
    ]
  })

  if (updates.length) await db.$transaction(updates)
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
}

export async function deleteEnvio(id: number) {
  // Los pedidos quedan liberados (envioId -> null) por onDelete: SetNull.
  await db.envio.delete({ where: { id } })
  revalidatePath('/envios')
  redirect('/envios')
}
