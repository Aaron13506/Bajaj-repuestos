import type { $Enums } from '@prisma/client'
import { db } from './db'
import { ALL_MODELS, isMotoModelId, type MotoModelId, type MotoModelInfo } from './modelo'

// MOTO_MODELS (lib/modelo.ts) es la tabla de las 15 motos y sus ids son los valores del
// enum MotoModel del schema. Si alguno se agrega, renombra o borra en un solo lado, esto
// deja de compilar en vez de fallar en runtime con un modelo que no existe.
type Assert<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type _ModelosEnSync = Assert<Equal<MotoModelId, $Enums.MotoModel>>

// Filtro por moto para las queries: `models` es un array de enum, así que la pregunta
// "¿esta pieza sirve para tal moto?" es `has`, no un LIKE sobre texto. De paso deja de
// haber falsos positivos: "Pulsar 150 BS4" ya no matchea contra "Pulsar 150 BS40".
export function whereModel(model?: string) {
  return isMotoModelId(model) ? { models: { has: model } } : {}
}

// Opciones para los filtros del catálogo:
//  - models: las 15 motos, fijas (salen del enum, no de lo que haya cargado en la DB)
//  - categories: las categorías (nameEs del ensamble, ej "Swing Arm") — SCOPEADAS a la
//    moto si se pasa una, para que Categoría muestre solo las de esa moto (cascada).
export async function getCatalogFilters(
  model?: string,
): Promise<{ models: readonly MotoModelInfo[]; categories: string[] }> {
  const catRows = await db.product.findMany({
    where: { isAssembly: true, ...whereModel(model) },
    distinct: ['nameEs'],
    select: { nameEs: true },
  })
  const categories = catRows.map((r) => r.nameEs).filter(Boolean).sort((a, b) => a.localeCompare(b))
  return { models: ALL_MODELS, categories }
}
