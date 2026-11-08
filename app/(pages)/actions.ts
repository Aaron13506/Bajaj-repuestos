'use server'

import { revalidatePath } from 'next/cache'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { marcarVistos } from '@/lib/novedades'

// Más que todos los trackings que puede mostrar el inicio de una vez; corta un pedido absurdo.
const MAX_VISTOS = 500

/** «Ya lo vi» del inicio: las novedades que estaban en pantalla dejan de serlo. */
export async function marcarNovedadesVistas(vistos: unknown): Promise<ActionResult> {
  const validos = Array.isArray(vistos) && vistos.length <= MAX_VISTOS && vistos.every(v =>
    v != null && Number.isInteger(v.id) && v.id > 0 && typeof v.clave === 'string' && v.clave.length <= 1100)
  if (!validos) return fallo('No se pudo leer qué novedades marcar. Recargá la página y probá de nuevo.')
  await marcarVistos(vistos as { id: number; clave: string }[])
  revalidatePath('/')
  return ok()
}
