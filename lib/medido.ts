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
