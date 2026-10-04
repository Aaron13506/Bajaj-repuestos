// Cuándo un proveedor ya no se puede borrar.
//
// Borrarlo no es inocuo: SupplierPrice se va en cascada (toda su lista de precios), pero
// Envio.supplierId, PedidoItem.supplierId y Movimiento.supplierId pasan a NULL — y NULL, en
// este modelo, significa "99rpm". Una caja de Garuda se convertía en una de 99rpm: calcEnvio
// dejaba de recibir el proveedor, el tramo facturado y las comisiones dejaban de aplicarse, y
// el landed de una caja que ya viajó cambiaba solo. Los pagos hechos a ese proveedor quedaban
// sin nombre en el libro.
//
// Mientras algo lo use, el proveedor es parte de la historia de esa plata y no se toca. Lo
// único que se puede borrar es uno recién creado o cargado por error, sin cajas, líneas ni
// pagos. Retirar uno con historia (que no aparezca más en los selectores pero conserve sus
// cajas) pediría un campo `archivedAt` y una migración: queda como decisión aparte.
//
// Pura y en lib/ porque la deciden la pantalla (para no ofrecer el botón) y la acción (el
// cerrojo de verdad).
export interface UsoProveedor {
  envios: number
  pedidoItems: number
  movimientos: number
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

export function motivoProveedorEnUso(u: UsoProveedor): string | null {
  const partes: string[] = []
  if (u.envios > 0) partes.push(plural(u.envios, 'caja', 'cajas'))
  if (u.pedidoItems > 0) partes.push(plural(u.pedidoItems, 'línea de pedido', 'líneas de pedido'))
  if (u.movimientos > 0) partes.push(plural(u.movimientos, 'pago en el libro', 'pagos en el libro'))
  if (partes.length === 0) return null
  return `En uso: ${partes.join(', ')}. Borrarlo cambiaría el costo de lo que ya se compró.`
}
