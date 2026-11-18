// Aviso al teléfono del dueño (app ntfy) cuando un tracking trae un evento nuevo. Lo llama
// lib/sync-trackings.ts después de guardar. NTFY_TOPIC vacío = apagado. APP_URL (la URL
// pública, sin barra final) da el link a la caja; sin ella el aviso llega igual, sin link.
// Un aviso que no sale no frena el seguimiento: se anota en el log y sigue.

import { metaEstado } from './track123'
import { esTramoTracking, TRAMO_TRACKING_META } from './tracking'

export type CambioTracking = {
  envioId: number
  caja: string | null
  tramo: string
  numero: string
  antes: string | null
  evento: string | null
  estado: string | null
}

const PROBLEMA = new Set(['exception', 'failed_attempt'])

/** El aviso de un cambio, o null si no hay nada nuevo que contar. */
export function avisoDeCambio(c: CambioTracking, appUrl?: string) {
  if (!c.evento || c.evento === c.antes) return null
  const meta = metaEstado(c.estado)
  const tramo = esTramoTracking(c.tramo) ? TRAMO_TRACKING_META[c.tramo].corto : c.tramo
  const link = appUrl ? `${appUrl}/envios/${c.envioId}` : undefined
  return {
    title: `${meta?.icon ?? '📦'} ${c.caja?.trim() || `Caja #${c.envioId}`} · ${tramo}`,
    message: `${meta ? `${meta.label} — ` : ''}${c.evento}\n${c.numero}`,
    priority: c.estado && PROBLEMA.has(c.estado) ? 4 : 3,
    ...(link ? { click: link, actions: [{ action: 'view', label: 'Ver caja', url: link }] } : {}),
  }
}

export async function avisarCambio(c: CambioTracking) {
  const topic = process.env.NTFY_TOPIC?.trim()
  if (!topic) return
  const aviso = avisoDeCambio(c, process.env.APP_URL?.trim().replace(/\/+$/, '') || undefined)
  if (!aviso) return
  try {
    // JSON y no headers: el título lleva emoji y un header HTTP no acepta fuera de latin1.
    const r = await fetch('https://ntfy.sh/', {
      method: 'POST',
      body: JSON.stringify({ topic, ...aviso }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) console.error(`ntfy respondió ${r.status} para la caja ${c.envioId}`)
  } catch (e) {
    console.error(`ntfy: no salió el aviso de la caja ${c.envioId}: ${(e as Error).message}`)
  }
}
