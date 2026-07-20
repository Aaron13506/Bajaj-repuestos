import { db } from './db'

export const ACTIVE_SUPPLIER_CONFIG_KEY = 'active_supplier_id'

export interface ActiveSupplier {
  id: number
  name: string
}

// Proveedor activo global (panel compartido, un solo admin). Se autorrepara: si el
// Config apunta a un proveedor borrado o el valor es inválido, cae a null (= 99rpm base).
export async function getActiveSupplier(): Promise<ActiveSupplier | null> {
  const row = await db.config.findUnique({ where: { key: ACTIVE_SUPPLIER_CONFIG_KEY } })
  const id = row ? parseInt(row.value) : NaN
  if (Number.isNaN(id)) return null
  return db.supplier.findUnique({ where: { id }, select: { id: true, name: true } })
}

export interface SupplierPriceOverride {
  priceUsd: number
  // true = priceUsd ya es el costo landed final (puesto en Venezuela); false = costo
  // de origen equivalente a priceInr, todavía necesita Shoppre/seguro/marítimo encima.
  isLanded: boolean
}

// Precios USD override de un proveedor, indexados por productId. Sin fila para un
// producto ⇒ el llamador debe caer al precio base en ₹ (Product.priceInr).
export async function getSupplierPriceMap(supplierId: number | null): Promise<Map<number, SupplierPriceOverride>> {
  if (supplierId == null) return new Map()
  const rows = await db.supplierPrice.findMany({
    where: { supplierId },
    select: { productId: true, priceUsd: true, isLanded: true },
  })
  return new Map(rows.map(r => [r.productId, { priceUsd: parseFloat(r.priceUsd.toString()), isLanded: r.isLanded }]))
}
