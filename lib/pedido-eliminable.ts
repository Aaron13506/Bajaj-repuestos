// Cuándo se puede BORRAR un pedido sin dejar historia rota.
//
// Borrar un Pedido arrastra en cascada todas sus líneas, y lo que cuelga de él no se va con
// él: los Movimiento quedan con pedidoId = null (un ingreso huérfano en el libro, plata que
// entró sin decir de quién), las cajas pierden líneas sin avisar, y en el stock propio lo
// que ya se entregó y sumó a Product.stock queda sin ningún registro que lo explique. Por
// eso solo se borra lo que nunca llegó a tener consecuencias.
//
// Es una función pura y vive en lib/ porque la deciden dos lados que no pueden discrepar: la
// pantalla (para no ofrecer el botón) y la acción (que es el cerrojo de verdad — una pestaña
// vieja o un POST directo se saltean la pantalla).
//
// Lo que NO se puede borrar tampoco se puede "cancelar" todavía: eso pide un estado nuevo
// que habría que entender en cobranza, clientes y los totales. Hasta entonces, un pedido con
// historia se queda como está.

export interface PedidoBorrable {
  tipo: string
  status: string
  depositUsd: { toString(): string } | number | null
  items: { envioId: number | null; shippingStatus: string; costRealUsd: unknown | null }[]
  /** Cantidad de Movimiento ligados al pedido (cobros, ajustes). */
  movimientos: number
}

export function motivoNoEliminable(p: PedidoBorrable): string | null {
  // Un pedido de cliente confirmado es un compromiso: se aprobó, normalmente con adelanto
  // cobrado. Solo el presupuesto (todavía no aceptado) se tira sin más. El stock propio nace
  // ya como 'pedido' —no hay aprobación ni cliente— y se rige por lo que le pasó, no por el
  // estado.
  if (p.tipo !== 'propio' && p.status !== 'presupuesto') {
    return 'Es un pedido confirmado con el cliente, no se puede borrar.'
  }

  const deposito = p.depositUsd == null ? 0 : parseFloat(p.depositUsd.toString())
  if (deposito > 0.005) {
    return 'Ya tiene plata cobrada: borrarlo dejaría esos ingresos sin pedido en el libro.'
  }
  if (p.movimientos > 0) {
    return `Tiene ${p.movimientos} movimiento${p.movimientos === 1 ? '' : 's'} en el libro: borrarlo los dejaría sueltos.`
  }
  if (p.items.some(i => i.costRealUsd != null)) {
    return 'Ya se registró el costo real de una compra de sus piezas.'
  }
  if (p.items.some(i => i.envioId != null)) {
    return 'Tiene piezas asignadas a un envío: sacalas de la caja primero.'
  }
  if (p.items.some(i => i.shippingStatus !== 'pendiente')) {
    return 'Ya se compró o se movió alguna de sus piezas.'
  }
  return null
}
