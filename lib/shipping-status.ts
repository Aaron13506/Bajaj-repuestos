// Pipeline físico de un pedido: India (compra → Shoppre) → USA → Venezuela → cliente.
// Es lineal; cada etapa tiene un índice (su posición en el array). El estado vive por
// PEDIDO —no por envío— porque en la fase de compra unos pedidos ya están comprados y
// otros no. Una vez consolidada la caja en Shoppre, todos avanzan juntos (ver avance
// masivo en actions.ts). `bought` marca desde qué etapa el pedido ya se compró (dejó de
// ser "pendiente"). Colores: dot = punto del stepper, badge = pill de estado.
export const SHIPPING_STATUSES = [
  { value: 'pendiente',        short: 'Por comprar', label: 'Pendiente de comprar',  icon: '🛒', bought: false, dot: 'bg-gray-300',   badge: 'bg-gray-100 text-gray-700' },
  { value: 'camino_shoppre',   short: 'A Shoppre',   label: 'Camino a Shoppre',      icon: '📦', bought: true,  dot: 'bg-sky-400',    badge: 'bg-sky-50 text-sky-600' },
  { value: 'en_shoppre',       short: 'En Shoppre',  label: 'En Shoppre (India)',    icon: '🇮🇳', bought: true,  dot: 'bg-sky-500',    badge: 'bg-sky-100 text-sky-700' },
  { value: 'camino_usa',       short: 'A USA',       label: 'Camino a USA',          icon: '✈️', bought: true,  dot: 'bg-indigo-400', badge: 'bg-indigo-50 text-indigo-600' },
  { value: 'en_usa',           short: 'En USA',      label: 'En USA',                icon: '🇺🇸', bought: true,  dot: 'bg-indigo-500', badge: 'bg-indigo-100 text-indigo-700' },
  { value: 'camino_venezuela', short: 'A Venezuela', label: 'Camino a Venezuela',    icon: '🚢', bought: true,  dot: 'bg-amber-400',  badge: 'bg-amber-50 text-amber-600' },
  { value: 'en_venezuela',     short: 'En Venezuela',label: 'En Venezuela',          icon: '🇻🇪', bought: true,  dot: 'bg-amber-500',  badge: 'bg-amber-100 text-amber-700' },
  { value: 'entregado',        short: 'Entregado',   label: 'Entregado',             icon: '✅', bought: true,  dot: 'bg-green-500',  badge: 'bg-green-100 text-green-700' },
] as const

export type ShippingStatus = (typeof SHIPPING_STATUSES)[number]['value']

const FIRST = SHIPPING_STATUSES[0].value
const LAST = SHIPPING_STATUSES[SHIPPING_STATUSES.length - 1].value

export function shippingStatusMeta(status: string) {
  return SHIPPING_STATUSES.find(s => s.value === status) ?? SHIPPING_STATUSES[0]
}

export function statusIndex(status: string) {
  const i = SHIPPING_STATUSES.findIndex(s => s.value === status)
  return i === -1 ? 0 : i
}

export function isValidStatus(status: string): status is ShippingStatus {
  return SHIPPING_STATUSES.some(s => s.value === status)
}

// Siguiente / anterior etapa (acotado a los extremos). null si no hay hacia dónde.
export function nextStatus(status: string): ShippingStatus | null {
  const i = statusIndex(status)
  return i < SHIPPING_STATUSES.length - 1 ? SHIPPING_STATUSES[i + 1].value : null
}
export function prevStatus(status: string): ShippingStatus | null {
  const i = statusIndex(status)
  return i > 0 ? SHIPPING_STATUSES[i - 1].value : null
}

export function isBought(status: string) {
  return shippingStatusMeta(status).bought
}
export function isDelivered(status: string) {
  return status === LAST
}
export function isPending(status: string) {
  return status === FIRST
}

// Resumen agregado de un envío: en qué etapa está la caja como un todo. La "etapa
// líder" del envío es la MÍNIMA entre los pedidos ya comprados (la caja solo llega a
// una etapa cuando la pieza más rezagada llega). Sirve para el badge de la lista y el
// stepper de la ficha.
export function envioStageSummary(pedidos: { shippingStatus: string }[]) {
  if (pedidos.length === 0) return null
  const pendientes = pedidos.filter(p => isPending(p.shippingStatus)).length
  const comprados = pedidos.filter(p => isBought(p.shippingStatus))
  const entregados = pedidos.filter(p => isDelivered(p.shippingStatus)).length

  // Etapa líder = mínimo índice entre los comprados; si no hay ninguno comprado, "pendiente".
  const leadIndex = comprados.length
    ? Math.min(...comprados.map(p => statusIndex(p.shippingStatus)))
    : 0
  const lead = SHIPPING_STATUSES[leadIndex]

  return {
    total: pedidos.length,
    pendientes,
    comprados: comprados.length,
    entregados,
    allDelivered: entregados === pedidos.length,
    // "mixto" cuando los comprados no están todos en la misma etapa.
    mixed: new Set(comprados.map(p => p.shippingStatus)).size > 1,
    lead,
    leadIndex,
  }
}
