import { db } from '@/lib/db'

// Texto por defecto que se usa cuando aún no se guardó nada en Config.
// Es editable desde /config (claves terminos_presupuesto / terminos_pedido).

export const DEFAULT_TERMINOS_PRESUPUESTO = `1. Este presupuesto tiene una validez de 7 días contados a partir de su emisión. Los precios están expresados en dólares estadounidenses (USD) y pueden variar según la disponibilidad del proveedor y la tasa de cambio vigente al momento de confirmar el pedido.
2. Trabajamos bajo la modalidad por encargo: cada pieza se solicita al proveedor en el exterior específicamente para el cliente, por lo que el pedido se gestiona únicamente una vez recibido el abono inicial.
3. Para confirmar el pedido se requiere un abono inicial (inicial) del 50% del total. El 50% restante se cancela al arribo de la mercancía, antes de la entrega.
4. Los pagos realizados en bolívares se calculan a la tasa de cambio vigente el día en que se efectúa cada pago.
5. Los tiempos de entrega son estimados y dependen del envío internacional y de los trámites aduaneros.`

export const DEFAULT_TERMINOS_PEDIDO = `1. Los precios están expresados en dólares estadounidenses (USD). Los pagos realizados en bolívares se calculan a la tasa de cambio vigente el día en que se efectúa cada pago.
2. Condiciones de pago: 50% de abono inicial (inicial) para gestionar el encargo y 50% restante al arribo de la mercancía, antes de la entrega.
3. El abono inicial no es reembolsable una vez solicitada la pieza al proveedor, por tratarse de un producto encargado específicamente para el cliente.
4. Los tiempos de entrega son estimados y pueden variar por demoras del envío internacional o de los trámites aduaneros, circunstancias ajenas a nuestro control.
5. El cliente debe revisar la mercancía al momento de recibirla. Cualquier pieza dañada, incorrecta o incompleta debe reportarse dentro de las 48 horas siguientes a la entrega, conservando el empaque original.
6. No se aceptan devoluciones de piezas que no presenten defecto de fábrica, ni de piezas que hayan sido instaladas, montadas o manipuladas.
7. La garantía cubre únicamente defectos de fábrica; no ampara el desgaste natural, el mal uso, la instalación inadecuada ni las piezas consideradas de desgaste (consumibles).
8. Al efectuar el abono inicial, el cliente declara haber leído y aceptado estos términos y condiciones.`

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
