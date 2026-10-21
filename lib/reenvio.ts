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
