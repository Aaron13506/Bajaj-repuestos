// El flete REAL de una caja aérea: lo que cobraron los dos transportistas, y si ya se les pagó.
//
// Son dos tramos con dos empresas distintas — el aéreo (Shoppre) y el marítimo Miami→Caracas —
// y cada uno se factura y se paga por separado. El facturado vive en Envio
// (`shippingCostRealAereo/Maritimo`) y es el COSTO, no una sugerencia: pisa al estimado de
// tabla en el landed. Lo pagado NO se guarda en la caja: se deriva del libro (Movimiento con
// categoria flete_* y envioId), igual que el "pagado al proveedor", para que un pago borrado
// desde contabilidad no deje la ficha mostrando lo viejo.

export type TramoFlete = 'aereo' | 'maritimo'

export const TRAMOS_FLETE: Record<TramoFlete, {
  categoria: 'flete_aereo' | 'flete_maritimo'
  columna: 'shippingCostRealAereo' | 'shippingCostRealMaritimo'
  titulo: string
  icono: string
}> = {
  aereo: { categoria: 'flete_aereo', columna: 'shippingCostRealAereo', titulo: 'Aéreo India → USA', icono: '✈️' },
  maritimo: { categoria: 'flete_maritimo', columna: 'shippingCostRealMaritimo', titulo: 'Marítimo Miami → Caracas', icono: '🚢' },
}

export const CATEGORIAS_FLETE = [TRAMOS_FLETE.aereo.categoria, TRAMOS_FLETE.maritimo.categoria] as const

export const esTramoFlete = (v: string): v is TramoFlete => v === 'aereo' || v === 'maritimo'

const EPS = 0.01

export type EstadoFlete =
  | { clave: 'sin_cargar'; texto: string }
  | { clave: 'por_pagar'; texto: string; faltaUsd: number }
  | { clave: 'parcial'; texto: string; faltaUsd: number }
  | { clave: 'pagado'; texto: string }
  | { clave: 'de_mas'; texto: string; sobraUsd: number }

const usd = (n: number) => `$${n.toFixed(2)}`

/** Estado de un tramo, derivado de lo facturado y de lo que el libro dice que salió. */
export function estadoFlete(facturadoUsd: number | null, pagadoUsd: number): EstadoFlete {
  if (facturadoUsd == null) {
    // Hay plata que salió contra un flete que nadie cargó: se dice, no se oculta.
    return pagadoUsd > EPS
      ? { clave: 'de_mas', texto: `pagado ${usd(pagadoUsd)} sin factura cargada`, sobraUsd: pagadoUsd }
      : { clave: 'sin_cargar', texto: 'sin cargar' }
  }
  const falta = facturadoUsd - pagadoUsd
  if (pagadoUsd <= EPS) return { clave: 'por_pagar', texto: `por pagar ${usd(facturadoUsd)}`, faltaUsd: facturadoUsd }
  if (falta > EPS) return { clave: 'parcial', texto: `pagado ${usd(pagadoUsd)} de ${usd(facturadoUsd)}`, faltaUsd: falta }
  if (falta < -EPS) return { clave: 'de_mas', texto: `pagado de más ${usd(-falta)}`, sobraUsd: -falta }
  return { clave: 'pagado', texto: 'pagado' }
}

/** ¿Un pago más de `montoUsd` se pasa de lo facturado? (tolerancia de un centavo) */
export function excedeFacturado(facturadoUsd: number, pagadoUsd: number, montoUsd: number): boolean {
  return pagadoUsd + montoUsd > facturadoUsd + EPS
}

/**
 * Resumen para la lista de cajas: cuántos tramos hay por pagar. Un tramo sin cargar no cuenta
 * como "por pagar" (no se sabe cuánto es), pero tampoco como pagado.
 */
export function resumenFletes(
  tramos: { facturadoUsd: number | null; pagadoUsd: number }[],
): 'por_pagar' | 'pagado' | 'sin_cargar' {
  const estados = tramos.map(t => estadoFlete(t.facturadoUsd, t.pagadoUsd).clave)
  if (estados.some(c => c === 'por_pagar' || c === 'parcial')) return 'por_pagar'
  if (estados.length > 0 && estados.every(c => c === 'pagado' || c === 'de_mas')) return 'pagado'
  return 'sin_cargar'
}
