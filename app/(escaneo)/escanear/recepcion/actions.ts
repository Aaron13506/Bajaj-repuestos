'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { conErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { abrirRecepcion } from '@/lib/recepcion-db'

// Desde el teléfono: "Llegó" marca la llegada de la caja, abre su recepción y lleva a contarla.
export async function llegoYContar(envioId: number): Promise<ActionResult> {
  let id: number | null = null
  const r = await conErrorDeNegocio(async () => { id = await abrirRecepcion(envioId, { llegada: true }) })
  if (!r.ok) return r
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  if (id == null) return { ok: false, error: 'La caja no espera nada: quedó marcada la llegada y no hay qué contar.' }
  redirect(`/escanear/recepcion/${id}`)
}
