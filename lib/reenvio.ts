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
//               kg cobrables × ₹/kg + gastos fijos por caja (repack y demás, en /config),
//               sin seguro. Sin tarifa cargada la caja queda subcosteada, no gratis.
//
// Los precios de venta y el catálogo siguen con la tabla de Shoppre: este reenvío solo
// abarata la caja real, nunca lo que se le cobra al cliente.
// ─────────────────────────────────────────────────────────────────────────────

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
    hint: 'Te cotizan ₹/kg al momento. Tramo = kg cobrables × ₹/kg + gastos fijos de /config. Sin seguro.',
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

// ─────────────────────────────────────────────────────────────────────────────
// Cambiar el reenvío de una caja ya creada
//
// Se congela al crear la caja porque, una vez comprada la mercancía, el proveedor ya la
// despachó a la dirección de UN depósito: cambiarlo después sería re-costear con un camino
// que no existe. Mientras no se compró nada ni se facturó o pagó el flete aéreo, en cambio,
// es solo una decisión que todavía no se tomó, y cambiarlo sirve para comparar.
// ─────────────────────────────────────────────────────────────────────────────

export interface CajaParaReenvio {
  modo: string
  /** El proveedor de la caja despacha él mismo (inbound 'cotizado'): no hay depósito. */
  despachaProveedor: boolean
  lineas: { shippingStatus: string; comprada: boolean }[]
  fleteAereoFacturado: boolean
  fleteAereoPagado: boolean
}

/** Por qué no se puede cambiar el reenvío de la caja, o null si se puede. */
export function motivoNoCambiaReenvio(c: CajaParaReenvio): string | null {
  if (c.modo !== 'aereo') return 'Solo las cajas aéreas tienen reenvío.'
  if (c.despachaProveedor) return 'El proveedor de esta caja despacha él mismo a USA: no pasa por ningún depósito.'
  if (c.lineas.some(l => l.comprada || l.shippingStatus !== 'pendiente')) {
    return 'Ya hay piezas compradas: la mercancía ya salió hacia un depósito y el reenvío quedó decidido.'
  }
  if (c.fleteAereoFacturado || c.fleteAereoPagado) return 'El flete aéreo ya está facturado o pagado.'
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarifa de equilibrio: el ₹/kg máximo que conviene aceptar del reenvío por kilo
//
// Lo que esta caja pagaría por Shoppre (tabla + seguro + processing, todo estimado) contra lo
// que pagaría por kilo: kg × t ÷ tasa + gastos fijos ÷ tasa. Igualando y despejando t:
//
//   t = (shoppreUsd × tasa − gastosFijosInr) ÷ kg cobrables
//
// Con una cotización por debajo, conviene el reenvío por kilo. Se compara estimado contra
// estimado a propósito: es para decidir antes de comprar, cuando no hay factura de ninguno.
// ─────────────────────────────────────────────────────────────────────────────

export function tarifaEquilibrioKgInr(p: {
  shoppreUsd: number
  chargeableKg: number
  /** null = sin configurar: se calcula como 0, y la pantalla lo dice. */
  gastosFijosInr: number | null
  inrUsd: number
}): number | null {
  if (p.chargeableKg <= 0 || p.inrUsd <= 0) return null
  return Math.max(0, (p.shoppreUsd * p.inrUsd - (p.gastosFijosInr ?? 0)) / p.chargeableKg)
}
