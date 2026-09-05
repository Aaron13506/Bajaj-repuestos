// ─────────────────────────────────────────────────────────────────────────────
// Normalización de JSON laxo.
//
// Todo lo que entra pegado a mano —la respuesta de una IA, una lista de un proveedor,
// un export de Excel— viene con los números como strings, con símbolos de moneda
// adentro y con celdas vacías que a veces son `null`, a veces `""` y a veces el string
// "null". Estas cuatro funciones son el filtro, y estaban copiadas en cuatro archivos
// (lib/measures.ts, lib/lista-skus.ts y los dos importadores). Idénticas hoy, que es
// justo cuando conviene unificarlas: divergen en silencio y el síntoma aparece meses
// después, en un solo importador y con un solo proveedor.
//
// Puras y sin dependencias: corren igual en el server action y en el navegador.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Número tolerante: acepta `1234`, `"1234"`, `"$ 1.234"`, `"12,5 kg"`.
 * `null` cuando no hay nada que leer o cuando lo que queda no es un número.
 */
export function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.-]/g, '')) : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Igual que `toNum` pero redondeado: gramos, unidades, cantidades. */
export function toInt(v: unknown): number | null {
  const n = toNum(v)
  return n == null ? null : Math.round(n)
}

/** Texto podado. `null` para vacío, para que caiga limpio en una columna nullable. */
export function toStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Dos decimales. La precisión del dinero y de los costos que se guardan. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** El mensaje de un error desconocido, para reportarlo fila por fila sin romper el lote. */
export function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error desconocido.'
}
