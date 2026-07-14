import type { BundlePiece } from './bundle'

// Campos de costo/dimensión de un producto necesarios para costear un envío.
export interface ProductCost {
  nameEs: string
  bajajCode: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
}

// Una pieza física ya resuelta, lista para el cálculo del envío.
export interface CostPiece {
  name: string
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  quantity: number
}

export type ProductLookup = (bajajCode: string | null, nameEs: string) => ProductCost | undefined

// Construye un lookup por bajajCode (preferido) y por nombre (respaldo) a partir
// de la lista de productos.
export function makeProductLookup(products: ProductCost[]): ProductLookup {
  const byCode = new Map<string, ProductCost>()
  const byName = new Map<string, ProductCost>()
  for (const p of products) {
    if (p.bajajCode) byCode.set(p.bajajCode, p)
    byName.set(p.nameEs, p)
  }
  return (code, name) => (code ? byCode.get(code) : undefined) ?? byName.get(name)
}

// Expande una línea de presupuesto en sus piezas físicas reales.
//
// Para una pieza suelta devuelve la pieza tal cual. Para un CONJUNTO (bundleItems
// presente) resuelve cada pieza incluida a su producto real para costearla por las
// piezas que efectivamente lleva, en vez del priceInr/peso del ensamble entero
// (que agrega TODAS sus piezas y sobreestima el costo).
export function expandCostPieces(
  product: ProductCost,
  quantity: number,
  bundleItems: BundlePiece[] | null,
  lookup: ProductLookup,
): CostPiece[] {
  if (!bundleItems || bundleItems.length === 0) {
    return [{
      name: product.nameEs,
      weightGrams: product.weightGrams,
      dimL: product.dimL,
      dimA: product.dimA,
      dimH: product.dimH,
      priceInr: product.priceInr,
      quantity,
    }]
  }

  return bundleItems.map(bp => {
    const resolved = lookup(bp.bajajCode, bp.nameEs)
    return {
      name: bp.nameEs,
      weightGrams: resolved?.weightGrams ?? null,
      dimL: resolved?.dimL ?? null,
      dimA: resolved?.dimA ?? null,
      dimH: resolved?.dimH ?? null,
      priceInr: resolved?.priceInr ?? null,
      quantity: bp.quantity * quantity,
    }
  })
}
