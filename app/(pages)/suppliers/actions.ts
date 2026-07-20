'use server'

import { db } from '@/lib/db'
import { ACTIVE_SUPPLIER_CONFIG_KEY } from '@/lib/suppliers'
import { revalidatePath } from 'next/cache'

export async function createSupplier(formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.create({ data: { name } })
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
}

export async function renameSupplier(id: number, formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.update({ where: { id }, data: { name } })
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
}

export async function deleteSupplier(id: number) {
  await db.supplier.delete({ where: { id } })

  // Si era el proveedor activo, limpiamos el Config para que no quede apuntando
  // a un id borrado (getActiveSupplier() se autorrepara igual, esto es prolijidad).
  const row = await db.config.findUnique({ where: { key: ACTIVE_SUPPLIER_CONFIG_KEY } })
  if (row && parseInt(row.value) === id) {
    await db.config.delete({ where: { key: ACTIVE_SUPPLIER_CONFIG_KEY } })
  }

  revalidatePath('/suppliers')
  revalidatePath('/products')
  revalidatePath('/', 'layout')
}

export async function setActiveSupplier(supplierId: number | null) {
  if (supplierId == null) {
    await db.config.deleteMany({ where: { key: ACTIVE_SUPPLIER_CONFIG_KEY } })
  } else {
    await db.config.upsert({
      where: { key: ACTIVE_SUPPLIER_CONFIG_KEY },
      update: { value: String(supplierId) },
      create: { key: ACTIVE_SUPPLIER_CONFIG_KEY, value: String(supplierId) },
    })
  }
  revalidatePath('/', 'layout')
}
