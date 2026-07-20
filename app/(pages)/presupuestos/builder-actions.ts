'use server'

import { db } from '@/lib/db'

// Componentes de UN ensamble, cargados on-demand cuando se selecciona (evita traer
// los ~14k componentes de todo el catálogo al abrir el armador de presupuestos).
export async function getAssemblyComponents(assemblyId: number) {
  const comps = await db.productComponent.findMany({
    where: { parentId: assemblyId },
    include: {
      child: { select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true } },
    },
    orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  })
  return comps.map(c => ({
    id: c.id,
    groupName: c.groupName,
    quantity: c.quantity,
    child: {
      id: c.child.id,
      nameEs: c.child.nameEs,
      bajajCode: c.child.bajajCode,
      price: parseFloat(c.child.price.toString()),
      imageUrl: c.child.imageUrl,
    },
  }))
}

// Búsqueda de piezas sueltas por nombre o código (server-side), en vez de mandar los
// 5.5k productos al navegador.
export async function searchProducts(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const rows = await db.product.findMany({
    where: {
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, compatibleModels: true },
    take: 12,
    orderBy: { nameEs: 'asc' },
  })
  return rows.map(p => ({
    id: p.id,
    nameEs: p.nameEs,
    bajajCode: p.bajajCode,
    price: parseFloat(p.price.toString()),
    imageUrl: p.imageUrl,
    compatibleModels: p.compatibleModels,
  }))
}
