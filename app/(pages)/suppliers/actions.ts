'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'

// El origen define la ruta física de todo lo que se le compre a este proveedor. Solo
// 'china' cambia algo (salta Shoppre); cualquier otro valor cae a India, que es la base.
function parseOrigen(formData: FormData): 'india' | 'china' {
  return formData.get('origen') === 'china' ? 'china' : 'india'
}

// FOB propio del proveedor, en USD por embarque marítimo. Vacío ⇒ null, y el embarque cae
// al default global de Config (cbm_fob_india_usd). No es un dato del producto ni de la
// naviera: es lo que ESTE proveedor cobra por sacar la carga.
function parseFob(formData: FormData): number | null {
  const raw = (formData.get('fobUsd') as string)?.trim()
  if (!raw) return null
  const n = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export async function createSupplier(formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.create({ data: { name, origen: parseOrigen(formData), fobUsd: parseFob(formData) } })
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
}

// Guarda nombre y origen juntos (un solo form por fila). Cambiar el origen NO reescribe
// los ítems ya comprados: cada PedidoItem guarda su propio snapshot, así que lo que ya
// viajó conserva la ruta con la que se compró.
export async function renameSupplier(id: number, formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  await db.supplier.update({ where: { id }, data: { name, origen: parseOrigen(formData), fobUsd: parseFob(formData) } })
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
}

export async function deleteSupplier(id: number) {
  await db.supplier.delete({ where: { id } })
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
}
