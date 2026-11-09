import { isDelivered, isPending, shippingStatusMeta } from './shipping-status'
import { motivoNoEntregable } from './saldo-entrega'
import type { IncidenciaAbierta } from './incidencias'

// Cómo se reparte la vista "Clientes" de /presupuestos: por lo que me toca hacer con cada pedido.
// Un pedido con algo recibido y entregable va a "Por entregar" aunque le falten piezas por
// comprar, porque eso es lo que se puede hacer hoy (se entrega lo que llegó).
export const ESTADOS_LISTA = [
  { id: 'todo', label: 'Todos' },
  { id: 'entregar', label: 'Por entregar' },
  { id: 'presu', label: 'Presupuestos' },
  { id: 'camino', label: 'En camino' },
  { id: 'comprar', label: 'Por comprar' },
  { id: 'entregados', label: 'Entregados' },
] as const
export type EstadoLista = Exclude<(typeof ESTADOS_LISTA)[number]['id'], 'todo'>

// Orden de "Todos": lo que se entrega, después lo que hay que responder, lo que viaja y lo que falta comprar.
export const PRIORIDAD_LISTA: Record<EstadoLista, number> = { entregar: 0, presu: 1, camino: 2, comprar: 3, entregados: 4 }

interface PedidoLista {
  status: string
  items: { shippingStatus: string; incidencias: IncidenciaAbierta[] }[]
}

// Un pedido de cliente que no está cancelado ni perdido (esos van a "Cerrados").
export function estadoLista(p: PedidoLista): EstadoLista {
  if (p.status === 'presupuesto') return 'presu'
  if (p.items.length > 0 && p.items.every(i => isDelivered(i.shippingStatus))) return 'entregados'
  // Lo recibido está acá aunque tenga un problema abierto: se ve en "Por entregar" para resolverlo,
  // y el botón Entregar solo aparece si alguna línea es entregable (entregable(), igual que confirmarEntrega).
  if (p.items.some(i => i.shippingStatus === 'en_venezuela')) return 'entregar'
  if (p.items.some(i => !isPending(i.shippingStatus) && !isDelivered(i.shippingStatus))) return 'camino'
  return 'comprar'
}

// Si hay algo que confirmarEntrega aceptaría (recibido y sin un problema abierto).
export function entregable(p: PedidoLista): boolean {
  return p.status === 'pedido' && p.items.some(i => motivoNoEntregable(i) === null)
}

// La etapa como se muestra. Lo propio no se le entrega a nadie: su último paso es entrar al depósito.
export function etapaVisible(status: string, propio: boolean) {
  const m = shippingStatusMeta(status)
  return propio && isDelivered(status) ? { ...m, short: 'En depósito', label: 'En el depósito', icon: '🏠' } : m
}
