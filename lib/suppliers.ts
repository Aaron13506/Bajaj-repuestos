import { db } from './db'

// El proveedor ACTIVO global se eliminó: era estado compartido para algo que es un dato
// de cada embarque (define sus precios y su FOB, y se congela al cerrarlo). En el catálogo
// quedó como filtro de pantalla (?proveedor=id), que es lo que realmente era: una
// comparación, no una preferencia.

export interface SupplierPriceOverride {
  priceUsd: number
  // true = priceUsd ya es el costo landed final (puesto en Venezuela); false = costo
  // de origen equivalente a priceInr, todavía necesita Shoppre/seguro/marítimo encima.
  isLanded: boolean
  // Múltiplo mínimo de compra de ESTE proveedor para esta pieza. No entra en ningún
  // cálculo de costo unitario —priceUsd es por pieza— pero es la diferencia entre "sale
  // US$0,40" y "hay que poner US$20". null = el proveedor no lo declara.
  moq: number | null
}

// Precios USD override de un proveedor, indexados por productId. Sin fila para un
// producto ⇒ el llamador debe caer al precio base en ₹ (Product.priceInr).
export async function getSupplierPriceMap(supplierId: number | null): Promise<Map<number, SupplierPriceOverride>> {
  if (supplierId == null) return new Map()
  const rows = await db.supplierPrice.findMany({
    where: { supplierId },
    select: { productId: true, priceUsd: true, isLanded: true, moq: true },
  })
  return new Map(rows.map(r => [
    r.productId,
    { priceUsd: parseFloat(r.priceUsd.toString()), isLanded: r.isLanded, moq: r.moq },
  ]))
}

// Las funciones que interpretan el MOQ (cumpleMoq, cantidadMinima) viven en lib/moq.ts:
// son puras y también corren en el navegador, y este módulo importa la base.
