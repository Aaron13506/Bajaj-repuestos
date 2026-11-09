import { ETAPAS_FUERA_DEL_DEPOSITO } from './reenvio'

// ─────────────────────────────────────────────────────────────────────────────
// Mover un presupuesto de una caja a otra, con la etapa que tiene
//
// Para partir una caja en el depósito: Shoppre despacha dos paquetes, cada uno con sus gastos
// fijos y su factura. Las líneas pasan tal cual (etapa, costo real, proveedor, ruta), así que
// las dos cajas tienen que ser la misma compra en todo lo que decide el costeo: mismo
// proveedor, mismo modo, mismo reenvío. Y la mercancía tiene que estar todavía en el depósito:
// una vez que salió hacia USA (o hacia Venezuela, en express) viaja en la caja en que salió.
//
// El flete facturado NO lo impide: hasta que se paga es un número a corregir (cada caja carga
// la suya). El PAGADO sí: ese pago fue por la caja entera y ya salió de la cuenta.
//
// La plata del proveedor no se mueve: los pagos y las comisiones del giro quedan en la caja
// donde se anotaron, y las dos cajas pasan a ser la misma compra (Envio.compraDeId) para que
// lo debido y lo pagado se sumen juntos (ver cuentasPorPagar).
// ─────────────────────────────────────────────────────────────────────────────

export interface CajaParaMover {
  id: number
  modo: string
  estado: string
  supplierId: number | null
  reenvio: string
  /** El proveedor despacha él mismo (inbound 'cotizado'): no hay depósito donde partir. */
  despachaProveedor: boolean
  /** Las líneas de la caja (no landed: esas no viajan en ninguna). */
  lineas: { shippingStatus: string; isLanded: boolean }[]
  fleteAereoPagado: boolean
  /** La caja raíz de su compra, si es parte de una caja partida (ver compraDe). */
  compraDeId: number | null
  /** Otras cajas apuntan a esta como su compra. */
  tieneHijas: boolean
}

// Desde camino_usa en adelante (camino_venezuela incluido, que es por donde sale el express).
const salioDelDeposito = (c: CajaParaMover) =>
  c.lineas.some(l => !l.isLanded && ETAPAS_FUERA_DEL_DEPOSITO.includes(l.shippingStatus))

/** Por qué no se puede pasar lo de `origen` a `destino`, o null si se puede. */
export function motivoNoMueve(origen: CajaParaMover, destino: CajaParaMover): string | null {
  if (origen.id === destino.id) return 'Es la misma caja.'
  if (origen.modo !== 'aereo' && origen.modo !== 'express') return 'Solo se mueven líneas entre cajas aéreas o express.'
  if (destino.modo !== origen.modo) return 'Las dos cajas tienen que ir por la misma vía (aérea o express).'
  if (destino.supplierId !== origen.supplierId) return 'Las dos cajas tienen que ser del mismo proveedor: la pieza ya se le compró a él.'
  if (compraDe(origen) !== compraDe(destino) && (destino.compraDeId != null || destino.tieneHijas)) {
    return 'La otra caja ya es parte de otra compra partida: elegí una de esta compra o una nueva.'
  }
  if (destino.reenvio !== origen.reenvio) return 'Las dos cajas tienen que ir por el mismo reenvío (Shoppre o por kilo).'
  if (origen.despachaProveedor) return 'El proveedor de esta caja despacha él mismo: no pasa por un depósito donde partirla.'
  if (origen.estado === 'borrador') return 'La caja está en borrador: quitá el presupuesto y agregalo a la otra.'
  if (destino.estado !== 'confirmado') {
    return destino.estado === 'borrador'
      ? 'La otra caja está en borrador: confirmala antes de pasarle piezas compradas.'
      : 'La otra caja ya se entregó.'
  }
  if (salioDelDeposito(origen)) return 'Esta caja ya salió del depósito: lo que lleva viaja junto.'
  if (salioDelDeposito(destino)) return 'La otra caja ya salió del depósito.'
  if (origen.fleteAereoPagado) return 'El flete de esta caja ya se pagó: fue por todo lo que lleva.'
  if (destino.fleteAereoPagado) return 'El flete de la otra caja ya se pagó.'
  return null
}

/**
 * Lo mismo para UNA línea que el proveedor no mandó (sin_enviar, la línea entera): nunca llegó al
 * depósito, así que no viaja con lo que lleva la caja ni la cubre su flete. Que la caja ya haya
 * salido o pagado el flete no la ata; el destino sí tiene que poder recibirla.
 */
export function motivoNoMueveSinEnviar(origen: CajaParaMover, destino: CajaParaMover): string | null {
  return motivoNoMueve({ ...origen, lineas: [], fleteAereoPagado: false }, destino)
}

/** La compra de una caja: la caja raíz de la familia (ella misma si no se partió). */
export const compraDe = (c: { id: number; compraDeId: number | null }) => c.compraDeId ?? c.id

/**
 * El `compraDeId` que toma el destino al recibir líneas del origen: la raíz de la compra del
 * origen. Las familias quedan planas (todas apuntan a la raíz); si ya eran la misma compra no
 * cambia nada. Supone que motivoNoMueve dio null.
 */
export function compraTrasMover(
  origen: { id: number; compraDeId: number | null },
  destino: { id: number; compraDeId: number | null },
): number | null {
  return compraDe(origen) === compraDe(destino) ? destino.compraDeId : compraDe(origen)
}
