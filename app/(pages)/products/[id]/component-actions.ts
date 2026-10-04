'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { fallo, ok, type ActionResult } from '@/lib/action-result'

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

// ¿Agregar `childId` bajo `parentId` cerraría un ciclo? Sí si `parentId` ya está dentro del
// despiece de `childId`, a cualquier profundidad (A contiene a B contiene a A). Un ciclo
// haría que toda expansión recursiva de un ensamble no termine nunca. Se baja por niveles,
// una consulta por nivel y no una por nodo (la base está lejos); el catálogo real es de 2-3
// niveles, el tope solo protege de una base que ya tenga un ciclo.
async function cerrariaCiclo(parentId: number, childId: number): Promise<boolean> {
  const vistos = new Set<number>([childId])
  let nivel = [childId]
  for (let profundidad = 0; nivel.length > 0 && profundidad < 12; profundidad++) {
    const filas = await db.productComponent.findMany({
      where: { parentId: { in: nivel } },
      select: { childId: true },
    })
    const siguiente: number[] = []
    for (const f of filas) {
      if (f.childId === parentId) return true
      if (!vistos.has(f.childId)) { vistos.add(f.childId); siguiente.push(f.childId) }
    }
    nivel = siguiente
  }
  return false
}

export async function addComponent(parentId: number, formData: FormData): Promise<ActionResult> {
  const childId = parseInt(formData.get('childId') as string)
  const groupName = (formData.get('groupName') as string | null)?.trim() || null
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(childId)) return fallo('Elegí la pieza que querés agregar.')
  if (childId === parentId) return fallo('Una pieza no puede ser componente de sí misma.')
  if (await cerrariaCiclo(parentId, childId)) return fallo('Esa pieza ya contiene a este ensamble: agregarla cerraría un ciclo.')

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
  return ok()
}

export async function removeComponent(parentId: number, componentId: number): Promise<ActionResult> {
  const fila = await db.productComponent.findUnique({ where: { id: componentId }, select: { parentId: true } })
  // Ya no existe (otra pestaña, un reintento): lo que se quería ya está logrado.
  if (!fila) return ok()
  if (fila.parentId !== parentId) return fallo('Ese componente no pertenece a este ensamble.')
  await db.productComponent.deleteMany({ where: { id: componentId, parentId } })
  revalidatePath(`/products/${parentId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
  return ok()
}

export async function addToAssembly(childId: number, formData: FormData): Promise<ActionResult> {
  const parentId = parseInt(formData.get('parentId') as string)
  const groupName = (formData.get('groupName') as string | null)?.trim() ?? ''
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(parentId)) return fallo('Elegí el ensamble.')
  if (parentId === childId) return fallo('Una pieza no puede ser componente de sí misma.')
  if (await cerrariaCiclo(parentId, childId)) return fallo('Ese ensamble ya está dentro de esta pieza: agregarlo cerraría un ciclo.')

  const group = groupName

  await db.productComponent.upsert({
    where: { parentId_childId_groupName: { parentId, childId, groupName: group } },
    update: { quantity },
    create: { parentId, childId, groupName: group, quantity },
  })

  revalidatePath(`/products/${childId}`)
  revalidatePath(`/products/${parentId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
  return ok()
}
