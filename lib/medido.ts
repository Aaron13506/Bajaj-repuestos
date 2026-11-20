// ─────────────────────────────────────────────────────────────────────────────
// Peso y medidas tomados a mano (Product.medidoAt).
//
// Todo el catálogo nació estimado: la IA, el dato de 99rpm, una cuenta sobre la caja. La
// estimación alcanza para cotizar, pero el flete se paga sobre lo que marca la balanza, así
// que a medida que las piezas llegan se pesan y se miden, y esta marca dice cuáles ya
// pasaron por ahí. Cubre los cuatro números juntos (peso + L×A×H): se cargan siempre juntos
// y un bulto se mide de una vez.
//
// Una pieza medida no la pisa la carga con IA (lib/measures.ts): una estimación nunca
// reemplaza una medición. Para volver a estimarla hay que desmarcarla a mano.
// ─────────────────────────────────────────────────────────────────────────────

export interface Fisico {
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

// En qué base está lo guardado (Product.medidaBase), siempre UNA pieza:
//  · 'empaque' = la pieza en su caja (lo de caja trae una unidad: se mide la caja). Es también lo
//    que estima la IA, que para lo chico de bolsa da la pieza misma (lib/prompts.ts).
//  · 'pieza'   = lo que viene de a varios en bolsa (tornillos, grommets): una pieza suelta, porque
//    la bolsa se adapta a lo que trae y su L×A×H es aire. El peso sale de la bolsa ÷ lo que trae.
//  · null      = medida a mano antes de que existiera la base: se re-mide en el próximo conteo.
export type MedidaBase = 'pieza' | 'empaque'
export const MEDIDA_BASES: readonly MedidaBase[] = ['pieza', 'empaque']

/**
 * Peso y volumen de UNA pieza. Todo lo que costea lee por acá y no las columnas directo, así una
 * regla nueva sobre la base entra en un solo lugar. Vacío sigue vacío (null), nunca cero.
 */
export function fisicoPorUnidad(p: Fisico): { gramos: number | null; cm3: number | null } {
  return {
    gramos: p.weightGrams,
    cm3: p.dimL == null || p.dimA == null || p.dimH == null ? null : p.dimL * p.dimA * p.dimH,
  }
}

/**
 * El peso de una pieza a partir de la bolsa entera: la balanza se equivoca menos con 10 arandelas
 * que con una de 2 g. A la décima de gramo, como se guarda (lib/parse.ts toGramos). null si la
 * cantidad no es un entero mayor que 0.
 */
export function pesoPorPieza(bolsaGramos: number, piezas: number): number | null {
  if (!Number.isInteger(piezas) || piezas < 1) return null
  return Math.round((bolsaGramos / piezas) * 10) / 10
}

export function cambioFisico(a: Fisico, b: Fisico): boolean {
  return a.weightGrams !== b.weightGrams || a.dimL !== b.dimL || a.dimA !== b.dimA || a.dimH !== b.dimH
}

/**
 * La fecha a guardar a partir del tilde del formulario.
 *
 * Destildado → null. Tildado sobre una pieza que ya estaba medida y cuyos números no
 * cambiaron → se conserva la fecha original: guardar el nombre no la re-mide. Cualquier
 * otro caso (recién marcada, o re-pesada con números nuevos) → ahora.
 */
export function medidoAtDesde(marcado: boolean, actual: Date | null, cambio: boolean): Date | null {
  if (!marcado) return null
  if (actual && !cambio) return actual
  return new Date()
}

/**
 * "07 oct 2026". La zona va fija y no la del proceso: el servidor corre en UTC y el
 * navegador no, y una marca puesta a las 21:00 en Caracas sería "mañana" en uno y "hoy" en
 * el otro (y la hidratación no corrige el texto distinto).
 */
export function fechaMedido(fecha: Date | string): string {
  return new Date(fecha).toLocaleDateString('es-VE', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Caracas',
  })
}

export function textoMedido(fecha: Date | string): string {
  return `Pesada y medida a mano el ${fechaMedido(fecha)}`
}
