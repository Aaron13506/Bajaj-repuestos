// Cómo COBRA el negocio: el cliente paga en efectivo, transferencia Bs o cripto.
// El primero es el default del selector al aprobar un presupuesto.
export const METODOS_PAGO_INGRESO = [
  'Pago móvil / Transferencia Bs',
  'Efectivo USD',
  'Binance / USDT',
] as const

// Cómo PAGA el negocio a un proveedor/gasto: nunca es "transferencia Bs" — el proveedor
// está afuera. El giro bancario ya tiene sus propias comisiones (Envio.comisionSaliente/
// Entrante, ver CLAUDE.md); esto es el MEDIO con el que se pagó, no ese costo.
export const METODOS_PAGO_EGRESO = [
  'Giro bancario',
  'Tarjeta',
  'Binance / USDT',
  'Efectivo USD',
] as const

export type MetodoPagoIngreso = (typeof METODOS_PAGO_INGRESO)[number]
export type MetodoPagoEgreso = (typeof METODOS_PAGO_EGRESO)[number]
