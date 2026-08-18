import { db } from './db'
import type { BundlePiece } from './bundle'

// Campos de costo/dimensión de un producto necesarios para costear un envío.
export interface ProductCost {
  id: number
  nameEs: string
  bajajCode: string | null
  // Contexto para la investigación de medidas con IA (ver components/MedidasIA).
  // Opcionales: la ficha del envío no los necesita y no los trae.
  nameEn?: string | null
  compatibleModels?: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
}

// Una pieza física ya resuelta, lista para el cálculo del envío. `productId` es null
// cuando una pieza de un conjunto no se pudo resolver contra el catálogo (SKU sin
// match): en ese caso no hay precio de proveedor que aplicarle.
export interface CostPiece {
  productId: number | null
  name: string
  sku: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  quantity: number
}

export type ProductLookup = (bajajCode: string | null, nameEs: string) => ProductCost | undefined

// Lookup acotado a las piezas que aparecen en estos conjuntos. La ficha de un envío se
// puede permitir traer el catálogo entero, pero un presupuesto suele tener 20 SKU: se
// consultan solo esos en vez de los ~5800 productos.
export async function lookupDeConjuntos(bundles: (BundlePiece[] | null | undefined)[]): Promise<ProductLookup> {
  const codes = new Set<string>()
  const names = new Set<string>()
  for (const piezas of bundles) {
    for (const p of piezas ?? []) {
      if (p.bajajCode) codes.add(p.bajajCode)
      else names.add(p.nameEs)
    }
  }
  if (codes.size === 0 && names.size === 0) return () => undefined

  const products = await db.product.findMany({
    where: { OR: [{ bajajCode: { in: [...codes] } }, { nameEs: { in: [...names] } }] },
    select: {
      id: true, nameEs: true, bajajCode: true, nameEn: true, compatibleModels: true,
      weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
    },
  })
  return makeProductLookup(products)
}

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
      productId: product.id,
      name: product.nameEs,
      sku: product.bajajCode,
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
      productId: resolved?.id ?? null,
      name: bp.nameEs,
      sku: bp.bajajCode,
      weightGrams: resolved?.weightGrams ?? null,
      dimL: resolved?.dimL ?? null,
      dimA: resolved?.dimA ?? null,
      dimH: resolved?.dimH ?? null,
      priceInr: resolved?.priceInr ?? null,
      quantity: bp.quantity * quantity,
    }
  })
}
