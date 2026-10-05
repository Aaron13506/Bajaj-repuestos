import { db } from '@/lib/db'

// Texto por defecto que se usa cuando aún no se guardó nada en Config.
// Es editable desde /config (claves terminos_presupuesto / terminos_pedido).

export const DEFAULT_TERMINOS_PRESUPUESTO = `1. Validez: este presupuesto tiene una validez de 7 días contados a partir de su emisión. Pasado ese plazo los precios pueden variar y debe solicitarse uno nuevo.
2. Moneda y forma de pago: los montos están expresados en dólares a tasa BCV. El pago en bolívares se calcula a la tasa BCV vigente el día en que se realice cada pago. Quien pague en divisas recibe el descuento indicado en este presupuesto.
3. Modalidad por encargo: cada pieza se solicita al proveedor en el exterior específicamente para el cliente. El pedido se gestiona únicamente una vez recibido el abono inicial, y los precios pueden variar según la disponibilidad del proveedor hasta ese momento.
4. Abono inicial: para confirmar el pedido se requiere un abono inicial mínimo del 50% del total. El saldo restante se cancela contra entrega.
5. El abono inicial no es reembolsable una vez solicitada la pieza al proveedor, por tratarse de un producto encargado específicamente para el cliente.
6. Tiempos de entrega: son estimados y pueden variar por demoras del envío internacional o de los trámites aduaneros, circunstancias ajenas a nuestro control.
7. Revisión de la mercancía: el cliente debe revisar la mercancía al momento de recibirla. Cualquier pieza dañada, incorrecta o incompleta debe reportarse dentro de las 48 horas siguientes a la entrega, conservando el empaque original.
8. Devoluciones: no se aceptan devoluciones de piezas que no presenten defecto de fábrica, ni de piezas que hayan sido instaladas, montadas o manipuladas.
9. Garantía: cubre únicamente defectos de fábrica; no ampara el desgaste natural, el mal uso, la instalación inadecuada ni las piezas consideradas de desgaste (consumibles).
10. Compatibilidad: las piezas se cotizan según la moto y el código indicados en este presupuesto, por lo tanto el cliente debe verificar que correspondan a su moto antes de confirmar.
11. Al realizar el abono inicial, el cliente declara haber leído y aceptado estos términos y condiciones.`

export const DEFAULT_TERMINOS_PEDIDO = `1. Moneda y forma de pago: los montos están expresados en dólares a tasa BCV. Los pagos realizados en bolívares se calculan a la tasa BCV vigente el día en que se efectúa cada pago. Quien pague en divisas recibe el descuento por pago en divisas indicado en este pedido.
2. Condiciones de pago: abono inicial mínimo del 50% para gestionar el encargo y saldo restante contra entrega.
3. Modalidad por encargo: cada pieza se solicita al proveedor en el exterior específicamente para el cliente.
4. El abono inicial no es reembolsable una vez solicitada la pieza al proveedor, por tratarse de un producto encargado específicamente para el cliente.
5. Los tiempos de entrega son estimados y pueden variar por demoras del envío internacional o de los trámites aduaneros, circunstancias ajenas a nuestro control.
6. El cliente debe revisar la mercancía al momento de recibirla. Cualquier pieza dañada, incorrecta o incompleta debe reportarse dentro de las 48 horas siguientes a la entrega, conservando el empaque original.
7. No se aceptan devoluciones de piezas que no presenten defecto de fábrica, ni de piezas que hayan sido instaladas, montadas o manipuladas.
8. La garantía cubre únicamente defectos de fábrica; no ampara el desgaste natural, el mal uso, la instalación inadecuada ni las piezas consideradas de desgaste (consumibles).
9. Compatibilidad: las piezas se cotizan según la moto y el código indicados en el presupuesto, por lo tanto el cliente debe verificar que correspondan a su moto antes de confirmar.
10. Al efectuar el abono inicial, el cliente declara haber leído y aceptado estos términos y condiciones.`

export const TERMINOS_DEFAULTS: Record<string, string> = {
  terminos_presupuesto: DEFAULT_TERMINOS_PRESUPUESTO,
  terminos_pedido: DEFAULT_TERMINOS_PEDIDO,
}

/**
 * Devuelve los T&C vigentes para un pedido según su estado.
 * `presupuesto` usa los términos de presupuesto; cualquier otro estado (pedido
 * confirmado) usa los del pedido oficial. Cae al texto por defecto si Config está vacío.
 */
export async function getTerminos(status: string): Promise<string> {
  const key = status === 'presupuesto' ? 'terminos_presupuesto' : 'terminos_pedido'
  const row = await db.config.findUnique({ where: { key } })
  return row?.value?.trim() || TERMINOS_DEFAULTS[key]
}
