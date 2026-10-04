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

// Reparte lo que se pagó de verdad por una LÍNEA (`PedidoItem.costRealUsd`, el total de la
// línea, no por unidad) entre las piezas físicas en que se expandió, en proporción a lo que
// cada una costaba según el catálogo. Una pieza suelta se lleva el monto entero.
//
// Devuelve null por pieza cuando la línea no tiene costo real: ahí vale el estimado. Si el
// catálogo no sabe el precio de ninguna pieza (denominador 0) se reparte en partes iguales,
// igual que registrarCompra, en vez de dividir por cero.
export function repartirCostoReal(
  costRealUsd: number | null,
  estimadosUsd: number[],
): (number | null)[] {
  if (costRealUsd == null) return estimadosUsd.map(() => null)
  const denom = estimadosUsd.reduce((s, e) => s + e, 0)
  return estimadosUsd.map(e => (denom > 0 ? costRealUsd * (e / denom) : costRealUsd / estimadosUsd.length))
}

// Expande una línea de presupuesto en sus piezas físicas reales.
//
// Para una pieza suelta devuelve la pieza tal cual. Para un CONJUNTO (bundleItems
// presente) resuelve cada pieza incluida a su producto real para costearla por las
// piezas que efectivamente lleva: un ensamble no tiene peso, medidas ni precio propios
// (no es una pieza), así que `product` es null y solo importa el snapshot.
//
// Una línea sin conjunto y sin pieza no existe: el CHECK PedidoItem_pieza_xor_conjunto lo
// impide en la base. Si llegara acá, mejor cortar que costearla en cero sin avisar.
export function expandCostPieces(
  product: ProductCost | null,
  quantity: number,
  bundleItems: BundlePiece[] | null,
  lookup: ProductLookup,
): CostPiece[] {
  if (!bundleItems || bundleItems.length === 0) {
    if (!product) throw new Error('Línea sin pieza ni conjunto: viola PedidoItem_pieza_xor_conjunto')
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
