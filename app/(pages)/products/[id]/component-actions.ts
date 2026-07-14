'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'

// Búsqueda de piezas para los selectores de "agregar componente / a ensamble",
// server-side, en vez de mandar los ~5.5k productos con cada ficha.
export async function searchProductsForPicker(
  term: string,
  excludeId: number,
  onlyAssemblies = false,
) {
  const q = term.trim()
  if (q.length < 2) return []
  return db.product.findMany({
    where: {
      id: { not: excludeId },
      ...(onlyAssemblies ? { isAssembly: true } : {}),
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, nameEs: true, bajajCode: true },
    take: 20,
    orderBy: { nameEs: 'asc' },
  })
}

export async function addComponent(parentId: number, formData: FormData) {
  const childId = parseInt(formData.get('childId') as string)
  const groupName = (formData.get('groupName') as string).trim() || null
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(childId) || childId === parentId) return

  const group = groupName ?? ''

  await db.productComponent.upsert({
    where: { parentId_childId_groupName: { parentId, childId, groupName: group } },
    update: { quantity },
    create: { parentId, childId, groupName: group, quantity },
  })

  revalidatePath(`/products/${parentId}`)
  revalidatePath(`/products/${childId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
}

export async function removeComponent(parentId: number, componentId: number) {
  await db.productComponent.delete({ where: { id: componentId } })
  revalidatePath(`/products/${parentId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
}

export async function addToAssembly(childId: number, formData: FormData) {
  const parentId = parseInt(formData.get('parentId') as string)
  const groupName = (formData.get('groupName') as string).trim()
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(parentId) || parentId === childId) return

  const group = groupName ?? ''

  await db.productComponent.upsert({
    where: { parentId_childId_groupName: { parentId, childId, groupName: group } },
    update: { quantity },
    create: { parentId, childId, groupName: group, quantity },
  })

  revalidatePath(`/products/${childId}`)
  revalidatePath(`/products/${parentId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
}
