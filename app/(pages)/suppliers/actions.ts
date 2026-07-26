'use server'

import { db } from '@/lib/db'
import { ACTIVE_SUPPLIER_CONFIG_KEY } from '@/lib/suppliers'
import { revalidatePath } from 'next/cache'

// El origen define la ruta física de todo lo que se le compre a este proveedor. Solo
// 'china' cambia algo (salta Shoppre); cualquier otro valor cae a India, que es la base.
function parseOrigen(formData: FormData): 'india' | 'china' {
  return formData.get('origen') === 'china' ? 'china' : 'india'
}

export async function createSupplier(formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.create({ data: { name, origen: parseOrigen(formData) } })
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
}

// Guarda nombre y origen juntos (un solo form por fila). Cambiar el origen NO reescribe
// los ítems ya comprados: cada PedidoItem guarda su propio snapshot, así que lo que ya
// viajó conserva la ruta con la que se compró.
export async function renameSupplier(id: number, formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.update({ where: { id }, data: { name, origen: parseOrigen(formData) } })
  revalidatePath('/suppliers')
  revalidatePath('/compras')
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
