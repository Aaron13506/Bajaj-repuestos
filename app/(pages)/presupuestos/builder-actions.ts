'use server'

import { db } from '@/lib/db'

// Componentes de UN ensamble, cargados on-demand cuando se selecciona (evita traer
// los ~14k componentes de todo el catálogo al abrir el armador de presupuestos).
export async function getAssemblyComponents(assemblyId: number) {
  const comps = await db.productComponent.findMany({
    where: { parentId: assemblyId },
    include: {
      child: {
        select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, models: true },
      },
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
      models: c.child.models,
    },
  }))
}

// Ensambles que CONTIENEN una pieza con este SKU. El filtro del armador corre sobre los
// headers ya cargados (nombre y código del ensamble), así que el SKU de una pieza —que es
// con lo que llega el cliente: tiene el código de la pieza, no el del ensamble— nunca
// puede matchear ahí. Solo se busca por bajajCode y no por nombre de pieza: "sensor"
// devolvería medio catálogo, mientras que un SKU identifica una pieza puntual.
export async function searchAssembliesByPiece(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const comps = await db.productComponent.findMany({
    where: {
      parent: { isAssembly: true },
      child: { bajajCode: { contains: q, mode: 'insensitive' } },
    },
    select: { parentId: true, child: { select: { nameEs: true, bajajCode: true } } },
    // Una pieza genérica (un tornillo) vive en cientos de ensambles; el tope evita
    // traer esa cola entera para una lista que igual no se puede recorrer a mano.
    take: 400,
    orderBy: { id: 'asc' },
  })
  // Un ensamble puede repetir la misma pieza en varios subgrupos: nos quedamos con
  // la primera aparición, que es la que se muestra como motivo del match.
  const byParent = new Map<number, { parentId: number; pieceName: string; pieceCode: string }>()
  for (const c of comps) {
    if (byParent.has(c.parentId)) continue
    byParent.set(c.parentId, {
      parentId: c.parentId,
      pieceName: c.child.nameEs,
      pieceCode: c.child.bajajCode ?? '',
    })
  }
  return Array.from(byParent.values())
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
    select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, models: true },
    take: 12,
    orderBy: { nameEs: 'asc' },
  })
  return rows.map(p => ({
    id: p.id,
    nameEs: p.nameEs,
    bajajCode: p.bajajCode,
    price: parseFloat(p.price.toString()),
    imageUrl: p.imageUrl,
    models: p.models,
  }))
}
