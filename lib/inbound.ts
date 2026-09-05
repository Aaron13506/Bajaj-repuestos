// ─────────────────────────────────────────────────────────────────────────────
// CÓMO LLEGA LA MERCANCÍA A USA
//
// `Supplier.origen` decía dónde está la mercancía Y cómo se cobra el tramo, porque
// durante un tiempo las dos cosas fueron la misma: India ⇒ Shoppre ⇒ tabla escalón de
// ShipGlobal; China ⇒ sin tabla, un monto que se carga a mano. Garuda Impex rompe esa
// coincidencia — está en India, cotiza en la misma lista de precios que los demás, y sin
// embargo despacha por India Post a la dirección de USA y pasa un total DDP.
//
// El eje que importa para costear NO es el país, es si el tramo tiene tarifa o no:
//
//   'shoppre'  la mercancía va al depósito de Shoppre y ShipGlobal cobra su tabla escalón
//              sobre el peso cobrable del GRUPO (por eso conviene juntar kilos ahí, y por
//              eso el punto dulce de los 11 kg solo aplica a este grupo).
//   'cotizado' el proveedor despacha él mismo y pasa un número. No hay nada que calcular:
//              se carga lo que facturó (Envio.tramoUsd) y se reparte entre las piezas.
//
// De acá para adelante los dos tramos son idénticos: la caja consolida en USA y cruza a
// Venezuela por mar a $/ft³, que es la parte que Garuda no cambia.
// ─────────────────────────────────────────────────────────────────────────────

export type Inbound = 'shoppre' | 'cotizado'

export const INBOUNDS: { value: Inbound; label: string; icon: string; hint: string }[] = [
  {
    value: 'shoppre',
    label: 'Shoppre',
    icon: '📦',
    hint: 'La mercancía entra al depósito de Shoppre en India y el tramo a USA lo cobra la tabla escalón de ShipGlobal sobre el peso cobrable. Suma seguro y processing.',
  },
  {
    value: 'cotizado',
    label: 'Cotizado (DDP)',
    icon: '🧾',
    hint: 'El proveedor despacha él mismo a USA y pasa un total con impuestos incluidos. No hay precio por kilo: el monto se carga en cada envío. No paga seguro ni processing de Shoppre.',
  },
]

export function isInbound(v: string | null | undefined): v is Inbound {
  return v === 'shoppre' || v === 'cotizado'
}

/**
 * El inbound efectivo de un proveedor o de una línea ya comprada.
 *
 * La regla de China vive acá y no repartida por el código: ese tramo NUNCA tuvo tabla de
 * tarifas —siempre fue el costo real facturado— así que un proveedor chino es 'cotizado'
 * aunque su fila diga otra cosa. Vale igual para las filas viejas, que se crearon cuando
 * la columna `inbound` no existía y por lo tanto quedaron en el default 'shoppre'.
 */
export function inboundDe(origen: string | null | undefined, inbound: string | null | undefined): Inbound {
  if (origen === 'china') return 'cotizado'
  return isInbound(inbound) ? inbound : 'shoppre'
}

export function inboundMeta(inbound: Inbound) {
  return INBOUNDS.find(i => i.value === inbound)!
}

// ─────────────────────────────────────────────────────────────────────────────
// Comisiones del giro
//
// No vive acá ninguna fórmula, y es a propósito. La comisión bancaria NO es un rasgo del
// proveedor: se le gira a algunos y a otros no, el banco cobra distinto según el monto y
// el corresponsal que toque, y guardar un porcentaje "de Garuda" habría producido un
// número inventado con apariencia de dato — el peor tipo de número en un costeo.
//
// Son DOS montos que se anotan por caja, y son dos porque el giro se cobra en las dos
// puntas y cada una se conoce en un momento distinto:
//
//   Envio.comisionSalienteUsd  lo que mi banco me descuenta al emitirlo. Se sabe el día.
//   Envio.comisionEntranteUsd  lo que le descuentan a ÉL al acreditar, y que termino
//                              completándole. Se sabe cuando el proveedor avisa que
//                              recibió menos que lo facturado.
//
// Las dos entran al landed tal cual, sumadas. Null significa "no lo cargué", que no es
// cero — y con una sola columna no se podía anotar una sin inventar la otra.
// ─────────────────────────────────────────────────────────────────────────────
