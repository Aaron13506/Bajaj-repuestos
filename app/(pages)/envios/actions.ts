'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

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

export async function deleteEnvio(id: number) {
  // Los pedidos quedan liberados (envioId -> null) por onDelete: SetNull.
  await db.envio.delete({ where: { id } })
  revalidatePath('/envios')
  redirect('/envios')
}
