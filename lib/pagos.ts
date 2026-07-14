// Métodos de pago aceptados para el adelanto de un pedido.
// El primero es el default del selector al aprobar un presupuesto.
export const METODOS_PAGO = [
  'Pago móvil / Transferencia Bs',
  'Efectivo USD',
  'Binance / USDT',
] as const

export type MetodoPago = (typeof METODOS_PAGO)[number]
