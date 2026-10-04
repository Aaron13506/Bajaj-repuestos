'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { nombreEnsamble } from '@/lib/linea-pedido'

// Búsqueda de piezas para el selector de "agregar componente", server-side, en vez de mandar
// los ~4.2k productos con cada ficha.
export async function buscarPiezas(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  return db.product.findMany({
    where: {
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

// Búsqueda de ensambles para el selector de "agregar a un ensamble". Se muestra la moto junto
// al nombre porque es lo único que distingue dos ensambles homónimos.
export async function buscarEnsambles(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const filas = await db.ensamble.findMany({
    where: {
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { nameEn: { contains: q, mode: 'insensitive' } },
        { compatibleModels: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, nameEs: true, nameEn: true, compatibleModels: true },
    take: 20,
    orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
  })
  return filas.map(e => ({ id: e.id, nameEs: nombreEnsamble(e), compatibleModels: e.compatibleModels }))
}

// Sin chequeo de ciclos: un ensamble solo contiene piezas y una pieza nunca contiene nada,
// así que el grafo no puede cerrarse. Esa garantía es la razón de que sean dos tablas.
//
// La pieza y el ensamble llegan de un selector que pudo quedar viejo (otra pestaña borró
// alguno): la FK lo rechaza con P2003 y se traduce a un mensaje en vez de un 500.
async function agregar(ensambleId: number, productId: number, groupName: string, quantity: number): Promise<ActionResult> {
  try {
    await db.ensambleComponente.upsert({
      where: { ensambleId_productId_groupName: { ensambleId, productId, groupName } },
      update: { quantity },
      create: { ensambleId, productId, groupName, quantity },
    })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2003') return fallo('Esa pieza o ese ensamble ya no existe. Recargá la página.')
    throw e
  }
  revalidatePath(`/ensambles/${ensambleId}`)
  revalidatePath(`/products/${productId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
  return ok()
}

// Desde la ficha del ensamble: se elige la pieza.
export async function addComponent(ensambleId: number, formData: FormData): Promise<ActionResult> {
  const productId = parseInt(formData.get('productId') as string)
  const groupName = (formData.get('groupName') as string | null)?.trim() ?? ''
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(productId)) return fallo('Elegí la pieza que querés agregar.')
  return agregar(ensambleId, productId, groupName, quantity)
}

// Desde la ficha de la pieza: se elige el ensamble.
export async function addToAssembly(productId: number, formData: FormData): Promise<ActionResult> {
  const ensambleId = parseInt(formData.get('ensambleId') as string)
  const groupName = (formData.get('groupName') as string | null)?.trim() ?? ''
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (isNaN(ensambleId)) return fallo('Elegí el ensamble.')
  return agregar(ensambleId, productId, groupName, quantity)
}

export async function removeComponent(ensambleId: number, componentId: number): Promise<ActionResult> {
  const fila = await db.ensambleComponente.findUnique({
    where: { id: componentId },
    select: { ensambleId: true, productId: true },
  })
  // Ya no existe (otra pestaña, un reintento): lo que se quería ya está logrado.
  if (!fila) return ok()
  if (fila.ensambleId !== ensambleId) return fallo('Ese componente no pertenece a este ensamble.')
  await db.ensambleComponente.deleteMany({ where: { id: componentId, ensambleId } })
  revalidatePath(`/ensambles/${ensambleId}`)
  revalidatePath(`/products/${fila.productId}`)
  revalidatePath('/groups')
  revalidatePath('/products')
  return ok()
}
