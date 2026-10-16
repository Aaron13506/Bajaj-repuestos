// Entregar contra el saldo (puro, sin DB).
//
// Los términos dicen "el saldo restante se cancela contra entrega", pero marcar una línea como
// entregada no miraba nada: se podía entregar con el 50% sin cobrar y el pedido seguía
// apareciendo en "por cobrar" mezclado con lo que todavía viaja, que es lo normal. Lo que sí es
// un riesgo es lo que ya se entregó y no se pagó, y eso no se distinguía.
import { isDelivered } from '@/lib/shipping-status'

const round2 = (n: number) => Math.round(n * 100) / 100

// Por debajo de esto el saldo es redondeo, no deuda.
export const TOLERANCIA_SALDO_USD = 0.01

// El saldo en dólares REALES (lo guardado): total de las líneas menos lo cobrado. Negativo = el
// cliente tiene saldo a favor.
export function saldoReal(items: { salePrice: number; quantity: number }[], depositUsd: number | null): number {
  return round2(items.reduce((s, i) => s + i.salePrice * i.quantity, 0) - (depositUsd ?? 0))
}

export function debeSaldo(saldoRealUsd: number): boolean {
  return saldoRealUsd > TOLERANCIA_SALDO_USD
}

// Dónde está lo que debe un pedido:
//   entregado    todo entregado y con saldo: lo que ya se llevó y no pagó (el riesgo real).
//   parcial      algo entregado y algo no: parte del saldo ya está en manos del cliente.
//   en_transito  nada entregado: el saldo es lo normal de un pedido en camino.
export type SituacionCobro = 'entregado' | 'parcial' | 'en_transito'

export function situacionDeCobro(items: { shippingStatus: string }[]): SituacionCobro {
  const entregadas = items.filter(i => isDelivered(i.shippingStatus)).length
  if (items.length > 0 && entregadas === items.length) return 'entregado'
  return entregadas > 0 ? 'parcial' : 'en_transito'
}

export const SITUACION_LABELS: Record<SituacionCobro, string> = {
  entregado: 'Entregado sin pagar',
  parcial: 'Entregado en parte',
  en_transito: 'En tránsito',
}

export function mensajeEntregaConSaldo(pedidos: { pedidoId: number; clientName: string; saldoUsd: number }[]): string {
  const lista = pedidos.map(p => `#${p.pedidoId} ${p.clientName} ($${p.saldoUsd.toFixed(2)})`).join(', ')
  return `Estos pedidos todavía deben saldo: ${lista}. El saldo se cobra contra entrega.`
}
