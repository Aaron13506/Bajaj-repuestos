// Los números de tracking de una caja, por tramo. Solo se anotan: el sistema no consulta
// nada afuera. Sirven para encontrar la caja cuando el cliente pregunta dónde está su pieza.
//
// Son una LISTA por tramo porque así llegan: el proveedor despacha en dos o tres paquetes y
// da un número local por cada uno, y el reenvío a USA o el courier a Venezuela pueden partir
// la carga igual. El tope es por tramo y es solo para que la pantalla no crezca sin fin.

export const TRAMOS_TRACKING = ['local', 'usa', 'venezuela'] as const
export type TramoTracking = (typeof TRAMOS_TRACKING)[number]

export const MAX_TRACKINGS_POR_TRAMO = 10
// Un número de guía real no pasa de unas decenas de caracteres; más largo es un pegado roto.
const MAX_LARGO = 80

export const TRAMO_TRACKING_META: Record<TramoTracking, { label: string; corto: string; ejemplo: string; transportista: string }> = {
  local: { label: 'Local en India · proveedor → depósito', corto: 'local', ejemplo: 'Ej: 1234567890', transportista: 'Ej: Delhivery' },
  usa: { label: 'Hacia USA', corto: 'USA', ejemplo: 'Ej: SHP-64898', transportista: 'Ej: Shoppre / DHL' },
  venezuela: { label: 'Hacia Venezuela', corto: 'VE', ejemplo: 'Ej: MIA-12345', transportista: 'Ej: Zoom / Tealca' },
}

export function esTramoTracking(v: unknown): v is TramoTracking {
  return typeof v === 'string' && (TRAMOS_TRACKING as readonly string[]).includes(v)
}

export type FilaTracking = { tramo: TramoTracking; numero: string; transportista: string | null }

/**
 * Las filas de un tramo tal como llegan del formulario (dos listas paralelas). Una fila sin
 * número se descarta (es el renglón vacío que quedó), pero una con transportista y sin número
 * se rechaza: se escribió algo y se perdería. Devuelve las filas o el motivo del rechazo.
 */
export function leerTrackingsTramo(
  tramo: TramoTracking,
  numeros: string[],
  transportistas: string[],
): { filas: FilaTracking[] } | { error: string } {
  const label = TRAMO_TRACKING_META[tramo].label
  const filas: FilaTracking[] = []
  for (let i = 0; i < numeros.length; i++) {
    const numero = (numeros[i] ?? '').trim()
    const transportista = (transportistas[i] ?? '').trim() || null
    if (!numero) {
      if (transportista) return { error: `${label}: hay un transportista sin número de tracking.` }
      continue
    }
    if (numero.length > MAX_LARGO || (transportista?.length ?? 0) > MAX_LARGO) {
      return { error: `${label}: un tracking pasa de ${MAX_LARGO} caracteres.` }
    }
    if (filas.some(f => f.numero.toLowerCase() === numero.toLowerCase())) {
      return { error: `${label}: el tracking ${numero} está repetido.` }
    }
    filas.push({ tramo, numero, transportista })
  }
  if (filas.length > MAX_TRACKINGS_POR_TRAMO) {
    return { error: `${label}: máximo ${MAX_TRACKINGS_POR_TRAMO} trackings.` }
  }
  return { filas }
}

/**
 * Los trackings de una caja en una línea, tramo por tramo y en el orden del viaje:
 * "local 123, 456 (Delhivery) · USA SHP-64898 (Shoppre)". Vacío si no hay ninguno.
 */
export function resumenTrackings(trackings: { tramo: string; numero: string; transportista: string | null }[]): string {
  return TRAMOS_TRACKING
    .map(tramo => {
      const deTramo = trackings.filter(t => t.tramo === tramo)
      if (deTramo.length === 0) return null
      const transportistas = [...new Set(deTramo.map(t => t.transportista).filter((t): t is string => !!t))]
      const quien = transportistas.length > 0 ? ` (${transportistas.join(', ')})` : ''
      return `${TRAMO_TRACKING_META[tramo].corto} ${deTramo.map(t => t.numero).join(', ')}${quien}`
    })
    .filter(Boolean)
    .join(' · ')
}
