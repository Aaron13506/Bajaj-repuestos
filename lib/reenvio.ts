// ─────────────────────────────────────────────────────────────────────────────
// QUIÉN LLEVA LA CAJA DE INDIA A USA (cuando la mercancía pasa por un depósito)
//
// `inbound` (lib/inbound.ts) dice si el tramo a USA lo cobra un reenvío ('shoppre') o lo
// factura el proveedor ('cotizado'). Esto dice CUÁL reenvío, y es de la caja, no del
// proveedor: la misma compra a 99rpm puede ir por Shoppre o por el otro, según convenga.
// Se elige al crear la caja y se congela como el proveedor.
//
//   'shoppre'   tabla escalón de ShipGlobal en USD, seguro y processing de Shoppre.
//   'por_kilo'  no hay tabla: el precio por kilo depende del tamaño del envío y lo cotizan
//               en el momento, en RUPIAS (Envio.tarifaKgInr). El tramo es
//               kg cobrables × ₹/kg, sin seguro. Sin tarifa cargada la caja queda
//               subcosteada, no gratis.
//
// El reempaque (Envio.reempaqueInr) es de cada caja en los dos: un paquete cuesta ₹100 y otro
// ₹1000, así que no hay número fijo que guardar en /config.
//
// Los precios de venta y el catálogo siguen con la tabla de Shoppre: este reenvío solo
// abarata la caja real, nunca lo que se le cobra al cliente.
// ─────────────────────────────────────────────────────────────────────────────

import { SHIPPING_STATUSES, statusIndex } from './shipping-status'

export type Reenvio = 'shoppre' | 'por_kilo'

export const REENVIOS: { value: Reenvio; label: string; hint: string }[] = [
  {
    value: 'shoppre',
    label: 'Shoppre',
    hint: 'Tabla escalón de ShipGlobal en USD. Suma seguro y processing.',
  },
  {
    value: 'por_kilo',
    label: 'Reenvío por kilo',
    hint: 'Te cotizan ₹/kg al momento. Tramo = kg cobrables × ₹/kg + el reempaque de la caja. Sin seguro.',
  },
]

export function isReenvio(v: string | null | undefined): v is Reenvio {
  return v === 'shoppre' || v === 'por_kilo'
}

export function reenvioDe(v: string | null | undefined): Reenvio {
  return isReenvio(v) ? v : 'shoppre'
}

export function reenvioMeta(r: Reenvio) {
  return REENVIOS.find(x => x.value === r)!
}

/** Etapas desde las que la mercancía ya dejó el depósito rumbo a USA. */
export const ETAPAS_FUERA_DEL_DEPOSITO = SHIPPING_STATUSES
  .filter(s => statusIndex(s.value) >= statusIndex('camino_usa'))
  .map(s => s.value as string)

// ─────────────────────────────────────────────────────────────────────────────
// Tarifa de equilibrio: el ₹/kg máximo que conviene aceptar del reenvío por kilo
//
// Lo que esta caja pagaría por Shoppre (tabla + seguro + processing, todo estimado) contra lo
// que pagaría por kilo: kg × t ÷ tasa. El reempaque se paga igual por los dos y se cancela.
// Igualando y despejando t:
//
//   t = shoppreUsd × tasa ÷ kg cobrables
//
// Con una cotización por debajo, conviene el reenvío por kilo. Se compara estimado contra
// estimado a propósito: es para decidir antes de comprar, cuando no hay factura de ninguno.
// ─────────────────────────────────────────────────────────────────────────────

export function tarifaEquilibrioKgInr(p: {
  shoppreUsd: number
  chargeableKg: number
  inrUsd: number
}): number | null {
  if (p.chargeableKg <= 0 || p.inrUsd <= 0) return null
  return Math.max(0, (p.shoppreUsd * p.inrUsd) / p.chargeableKg)
}
