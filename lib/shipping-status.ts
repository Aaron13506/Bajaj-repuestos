// Pipeline físico de una LÍNEA de pedido: compra → consolidación en USA → Venezuela →
// cliente. El estado vive por ÍTEM, no por pedido ni por envío: de un mismo presupuesto
// unas piezas se compran en India y otras en China, en momentos distintos. El estado del
// pedido es derivado (ver pedidoStageSummary).
//
// Las tres rutas comparten el mismo array canónico y el mismo orden — solo cambia por
// dónde arrancan, porque India y China consolidan las dos en USA:
//
//   india:   pendiente → camino_shoppre → en_shoppre → camino_usa → en_usa → ...
//   china:   pendiente ───────────────────────────────→ camino_usa → en_usa → ...
//   directo: pendiente ──────────────────────────────────────────→ en_venezuela → entregado
//
// 'directo' es el proveedor que cotiza puesto en Venezuela (SupplierPrice.isLanded): esa
// pieza nunca viaja en la caja, así que tampoco suma peso ni volumen al envío.
//
// `bought` marca desde qué etapa el ítem ya se compró (dejó de ser "pendiente").
// Colores: dot = punto del stepper, badge = pill de estado.
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

// ── Rutas ────────────────────────────────────────────────────────────────────
// Cada ruta es un SUBCONJUNTO del array canónico, en el mismo orden. Por eso
// statusIndex sigue siendo comparable entre rutas distintas: un ítem de China en
// 'en_usa' está tan avanzado como uno de India en 'en_usa'.

export type Origen = 'india' | 'china'
export type Ruta = 'india' | 'china' | 'directo'

const ROUTE_STATUSES: Record<Ruta, readonly ShippingStatus[]> = {
  india: SHIPPING_STATUSES.map(s => s.value),
  china: ['pendiente', 'camino_usa', 'en_usa', 'camino_venezuela', 'en_venezuela', 'entregado'],
  directo: ['pendiente', 'en_venezuela', 'entregado'],
}

// La ruta sale del origen del proveedor, salvo que haya cotizado puesto en Venezuela
// (isLanded): en ese caso la pieza no pasa por el pipeline, venga de donde venga.
export function routeFor(origen: string, isLanded: boolean): Ruta {
  if (isLanded) return 'directo'
  return origen === 'china' ? 'china' : 'india'
}

// Etapas que aplican a una ruta, con su metadata (para steppers y selects).
export function routeStages(ruta: Ruta) {
  const allowed = ROUTE_STATUSES[ruta]
  return SHIPPING_STATUSES.filter(s => allowed.includes(s.value))
}

// Cuántas etapas le faltan a un ítem para estar entregado, DENTRO DE SU RUTA. Se cuenta
// por ruta y no por el índice global porque las rutas tienen largos distintos: algo que
// el proveedor manda puesto en Venezuela está a 1 paso del final desde 'pendiente',
// mientras que lo mismo comprado en India está a 7. 0 = entregado.
export function pasosRestantes(status: string, ruta: Ruta): number {
  const allowed = ROUTE_STATUSES[ruta]
  const i = statusIndex(normalizeToRoute(status, ruta))
  return allowed.filter(s => statusIndex(s) > i).length
}

// Un ítem 'directo' o 'china' nunca debería quedar en una etapa de India. Si por un
// cambio de proveedor quedó en una etapa que su ruta no tiene, se lo lleva a la
// siguiente etapa válida hacia adelante (nunca retrocede el progreso).
export function normalizeToRoute(status: string, ruta: Ruta): ShippingStatus {
  const allowed = ROUTE_STATUSES[ruta]
  if (allowed.includes(status as ShippingStatus)) return status as ShippingStatus
  const i = statusIndex(status)
  return allowed.find(s => statusIndex(s) >= i) ?? allowed[allowed.length - 1]
}

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

// Siguiente / anterior etapa DENTRO DE LA RUTA (salta las que no aplican: un ítem de
// China pasa de 'pendiente' directo a 'camino_usa', sin escalas en Shoppre).
// null si no hay hacia dónde.
export function nextStatus(status: string, ruta: Ruta = 'india'): ShippingStatus | null {
  const allowed = ROUTE_STATUSES[ruta]
  const i = statusIndex(normalizeToRoute(status, ruta))
  return allowed.find(s => statusIndex(s) > i) ?? null
}
export function prevStatus(status: string, ruta: Ruta = 'india'): ShippingStatus | null {
  const allowed = ROUTE_STATUSES[ruta]
  const i = statusIndex(normalizeToRoute(status, ruta))
  const anteriores = allowed.filter(s => statusIndex(s) < i)
  return anteriores.length ? anteriores[anteriores.length - 1] : null
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

// Resumen agregado de un conjunto de ítems: en qué etapa está el grupo como un todo.
// Sirve igual para un ENVÍO (la caja) que para un PEDIDO (el presupuesto), porque en
// los dos casos la pregunta es la misma: "de todo esto, ¿qué falta y hasta dónde llegó?".
//
// La "etapa líder" es la MÍNIMA entre los ítems ya comprados: el grupo solo llega a una
// etapa cuando llega su pieza más rezagada. Los que siguen pendientes no arrastran el
// líder hacia atrás (si no, un solo ítem sin comprar dejaría todo en cero) pero se
// cuentan aparte para poder mostrar "3 de 7 comprados".
export function stageSummary(items: { shippingStatus: string }[]) {
  if (items.length === 0) return null
  const pendientes = items.filter(i => isPending(i.shippingStatus)).length
  const comprados = items.filter(i => isBought(i.shippingStatus))
  const entregados = items.filter(i => isDelivered(i.shippingStatus)).length

  // Etapa líder = mínimo índice entre los comprados; si no hay ninguno comprado, "pendiente".
  const leadIndex = comprados.length
    ? Math.min(...comprados.map(i => statusIndex(i.shippingStatus)))
    : 0
  const lead = SHIPPING_STATUSES[leadIndex]

  return {
    total: items.length,
    pendientes,
    comprados: comprados.length,
    entregados,
    allDelivered: entregados === items.length,
    // "mixto" cuando los comprados no están todos en la misma etapa.
    mixed: new Set(comprados.map(i => i.shippingStatus)).size > 1,
    lead,
    leadIndex,
  }
}
