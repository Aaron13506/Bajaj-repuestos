// ─────────────────────────────────────────────────────────────────────────────
// Motos compatibles de un producto.
//
// `Product.compatibleModels` guarda texto: casi siempre UN modelo, pero los ensambles que
// sirven para varias motos a la vez (los accesorios N250/N160, los tornillos que comparten
// media docena de Pulsar) guardan la lista separada por comas.
//
// Vive en su propio módulo, sin importar `db`, porque lo necesitan por igual las páginas
// de servidor (para armar el dropdown) y los componentes cliente (para filtrar). Cualquier
// helper que arrastre el cliente de Prisma no se puede importar desde un 'use client'.
// ─────────────────────────────────────────────────────────────────────────────

/** Modelos de un producto, ya separados y limpios. */
export function parseModelos(compatibleModels: string | null | undefined): string[] {
  return (compatibleModels ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
}

/**
 * Opciones distintas para un dropdown, a partir de una lista de productos. Se aplanan las
 * listas: un ensamble multi-modelo tiene que aparecer bajo CADA una de sus motos, no como
 * una opción compuesta que después no matchea con nada al filtrar.
 */
export function modelosDistintos(valores: (string | null | undefined)[]): string[] {
  return [...new Set(valores.flatMap(parseModelos))]
}

/** ¿Este producto sirve para esa moto? Compara contra la lista, no contra el texto entero. */
export function sirveParaModelo(compatibleModels: string | null | undefined, modelo: string): boolean {
  return parseModelos(compatibleModels).includes(modelo)
}
