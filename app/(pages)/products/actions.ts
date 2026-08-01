'use server'

import { db } from '@/lib/db'
import { isMotoModelId } from '@/lib/modelo'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

// Costo landed autoritativo: se recalcula en el server desde el costo de origen
// (₹ INR de 99rpm, o USD directo de un proveedor) + peso + dims y la config vigente,
// así no depende del JS del cliente. Devuelve null si falta el costo o el peso
// (precio queda manual).
async function computeLanded(data: {
  priceInr: number | null
  priceUsd?: number | null
  priceIsLanded?: boolean
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}): Promise<number | null> {
  const rows = await db.config.findMany()
  const cfg = rows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const b = calcLanded({ ...data, margin: null }, cfg)
  return b ? Math.round(b.landedCostUsd * 100) / 100 : null
}

function parseProductForm(formData: FormData) {
  const priceInr     = formData.get('priceInr') as string
  const weightGrams  = formData.get('weightGrams') as string
  const dimL         = formData.get('dimL') as string
  const dimA         = formData.get('dimA') as string
  const dimH         = formData.get('dimH') as string
  const landedCostUsd = formData.get('landedCostUsd') as string
  const margin       = formData.get('margin') as string

  return {
    isAssembly:       formData.get('isAssembly') === 'true',
    bajajCode:        (formData.get('bajajCode') as string) || null,
    sourceUrl:        (formData.get('sourceUrl') as string) || null,
    nameEs:            formData.get('nameEs') as string,
    nameEn:           (formData.get('nameEn') as string) || null,
    description:      (formData.get('description') as string) || null,
    notes:            (formData.get('notes') as string) || null,
    models:           formData.getAll('models').filter(isMotoModelId),
    weightGrams:      weightGrams ? parseInt(weightGrams) : null,
    dimL:             dimL ? parseFloat(dimL) : null,
    dimA:             dimA ? parseFloat(dimA) : null,
    dimH:             dimH ? parseFloat(dimH) : null,
    priceInr:         priceInr ? parseInt(priceInr) : null,
    landedCostUsd:    landedCostUsd ? parseFloat(landedCostUsd) : null,
    margin:           margin ? parseFloat(margin) / 100 : null,
    price:            parseFloat(formData.get('price') as string),
    priceLocked:      formData.get('priceLocked') === 'true',
    stock:            parseInt(formData.get('stock') as string) || 0,
  }
}

export async function createProduct(formData: FormData) {
  const data     = parseProductForm(formData)
  const parentId = formData.get('parentId') as string
  const groupName = (formData.get('parentGroupName') as string)?.trim() ?? ''

  const landed = await computeLanded(data)
  if (landed != null) data.landedCostUsd = landed

  const product = await db.product.create({ data })

  if (parentId) {
    const pid = parseInt(parentId)
    if (!isNaN(pid)) {
      await db.productComponent.create({
        data: { parentId: pid, childId: product.id, groupName, quantity: 1 },
      })
    }
  }

  revalidatePath('/products')
  revalidatePath('/groups')
  redirect('/products')
}

export async function updateProduct(id: number, formData: FormData) {
  const data = parseProductForm(formData)
  const landed = await computeLanded(data)
  if (landed != null) data.landedCostUsd = landed
  await db.product.update({ where: { id }, data })
  revalidatePath('/products')
  revalidatePath('/groups')
  redirect('/products')
}

// Edición rápida (modal inline): actualiza solo los campos editables, recalcula
// el landed y revalida SIN redirigir, para quedarse en la misma página.
//
// Costo de origen: sin proveedor activo edita Product.priceInr (base, 99rpm, en ₹)
// como siempre. Con un proveedor activo, en cambio, NO toca el precio base — sube/borra
// un override en SupplierPrice (en USD) para ese (producto, proveedor), y el resto de
// campos (peso, dims, margen, precio venta, stock) siguen escribiendo en Product como
// siempre, porque solo el costo de origen varía entre proveedores.
export async function quickUpdateProduct(id: number, activeSupplierId: number | null, formData: FormData) {
  const str = (k: string) => (formData.get(k) as string)?.trim() ?? ''
  const intOrNull   = (k: string) => { const v = str(k); return v ? parseInt(v) : null }
  const floatOrNull = (k: string) => { const v = str(k); return v ? parseFloat(v) : null }

  const submittedPriceInr = intOrNull('priceInr')
  const submittedPriceUsd = floatOrNull('priceUsd')
  const submittedIsLanded = formData.get('priceIsLanded') === 'true'

  const baseFields = {
    nameEs:           str('nameEs'),
    nameEn:           str('nameEn') || null,
    bajajCode:        str('bajajCode') || null,
    models:           formData.getAll('models').filter(isMotoModelId),
    weightGrams:      intOrNull('weightGrams'),
    dimL:             floatOrNull('dimL'),
    dimA:             floatOrNull('dimA'),
    dimH:             floatOrNull('dimH'),
    margin:           str('margin') ? parseFloat(str('margin')) / 100 : null,
    price:            parseFloat(str('price')),
    priceLocked:      formData.get('priceLocked') === 'true',
    stock:            intOrNull('stock') ?? 0,
  }

  let effectivePriceInr: number | null
  let effectivePriceUsd: number | null = null
  let effectiveIsLanded = false

  if (activeSupplierId) {
    if (submittedPriceUsd != null) {
      await db.supplierPrice.upsert({
        where: { productId_supplierId: { productId: id, supplierId: activeSupplierId } },
        update: { priceUsd: submittedPriceUsd, isLanded: submittedIsLanded },
        create: { productId: id, supplierId: activeSupplierId, priceUsd: submittedPriceUsd, isLanded: submittedIsLanded },
      })
      effectivePriceUsd = submittedPriceUsd
      effectiveIsLanded = submittedIsLanded
    } else {
      await db.supplierPrice.deleteMany({ where: { productId: id, supplierId: activeSupplierId } })
    }
    const base = await db.product.findUnique({ where: { id }, select: { priceInr: true } })
    effectivePriceInr = base?.priceInr ?? null
  } else {
    effectivePriceInr = submittedPriceInr
  }

  const data = {
    ...baseFields,
    ...(activeSupplierId ? {} : { priceInr: submittedPriceInr }),
    landedCostUsd: null as number | null,
  }

  const landed = await computeLanded({
    priceInr:      effectivePriceInr,
    priceUsd:      effectivePriceUsd,
    priceIsLanded: effectiveIsLanded,
    weightGrams:   baseFields.weightGrams,
    dimL:          baseFields.dimL,
    dimA:          baseFields.dimA,
    dimH:          baseFields.dimH,
  })
  if (landed != null) data.landedCostUsd = landed

  await db.product.update({ where: { id }, data })
  revalidatePath('/products')
  revalidatePath('/groups')
}

export async function deleteProduct(id: number) {
  await db.product.delete({ where: { id } })
  revalidatePath('/products')
  revalidatePath('/groups')
}
