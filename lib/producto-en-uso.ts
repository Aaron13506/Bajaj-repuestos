// Cuándo un producto ya no se puede borrar.
//
// PedidoItem.product, EnvioLinea.product y EnsambleComponente.product son `Restrict`: la base
// se niega a borrar una pieza que un pedido, una caja o un ensamble todavía referencia. Sin
// mirar antes, esa negativa llegaba como un P2003 crudo y, en producción, como una página de
// error sin explicación. Contar primero permite decir QUÉ la retiene.
//
// Lo que sí se va solo con la pieza: sus precios de proveedor (SupplierPrice, cascada).
//
// Pura y en lib/ por la misma razón que motivoProveedorEnUso: la usa la acción, y puede
// usarla una pantalla que quiera no ofrecer el botón.
export interface UsoProducto {
  pedidoItems: number
  envioLineas: number
  /** Cuántos ensambles la tienen como componente. */
  ensambles: number
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

export function motivoProductoEnUso(u: UsoProducto): string | null {
  const partes: string[] = []
  if (u.pedidoItems > 0) partes.push(plural(u.pedidoItems, 'línea de pedido', 'líneas de pedido'))
  if (u.envioLineas > 0) partes.push(plural(u.envioLineas, 'línea de un embarque marítimo', 'líneas de embarques marítimos'))
  if (u.ensambles > 0) partes.push(plural(u.ensambles, 'ensamble que la usa', 'ensambles que la usan'))
  if (partes.length === 0) return null
  return `Está en uso: ${partes.join(', ')}. Sacala de ahí primero.`
}

// Cuándo un ENSAMBLE ya no se puede borrar. Lo retienen las líneas de pedido que lo vendieron
// como conjunto (PedidoItem.ensambleId es `Restrict`): borrarlo dejaría el historial de ventas
// sin saber qué se vendió. Lo que sí se va solo con él son los enlaces a sus piezas
// (EnsambleComponente.ensamble, cascada); las piezas en sí quedan sueltas en el catálogo.
export function motivoEnsambleEnUso(u: { pedidoItems: number }): string | null {
  if (u.pedidoItems === 0) return null
  return `Está en uso: ${plural(u.pedidoItems, 'línea de pedido', 'líneas de pedido')}. Sacalo de ahí primero.`
}
