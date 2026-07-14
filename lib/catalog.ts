import { db } from './db'

// Orden lógico de los 14 modelos (por cilindrada/familia) para los dropdowns de filtro.
// Los valores son las etiquetas legibles tal como se guardan en Product.compatibleModels.
export const MODEL_ORDER = [
  'Pulsar 150 BS4',
  'Pulsar 150 UG4',
  'Pulsar 180 BS3 2009 16 UG4',
  'Pulsar 180 BS4 2017 19',
  'Pulsar 200NS BS3 2012 16',
  'Pulsar NS200 BS4 2017 19',
  'Pulsar NS200 BS6 2020',
  'Pulsar NS200 BS6 2021 23',
  'Pulsar NS200 USD Fork 2023',
  'Pulsar N160 Single ABS 2022 23',
  'Pulsar N160 Dual ABS 2022 23',
  'Pulsar N250 Single ABS 2021 23',
  'Pulsar N250 Dual ABS 2022 23',
  'Pulsar N250 USD Fork 2024 25',
]

export function sortModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const ia = MODEL_ORDER.indexOf(a)
    const ib = MODEL_ORDER.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b)
  })
}

// Opciones para los filtros del catálogo, derivadas de los ensambles reales:
//  - models: los 14 modelos distintos (cada ensamble = 1 modelo en compatibleModels)
//  - categories: las categorías (nameEs del ensamble, ej "Swing Arm") — SCOPEADAS al
//    modelo si se pasa uno, para que Categoría muestre solo las de ese modelo (cascada).
export async function getCatalogFilters(model?: string): Promise<{ models: string[]; categories: string[] }> {
  const [modelRows, catRows] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: true, compatibleModels: { not: null } },
      distinct: ['compatibleModels'],
      select: { compatibleModels: true },
    }),
    db.product.findMany({
      where: {
        isAssembly: true,
        ...(model ? { compatibleModels: { contains: model, mode: 'insensitive' as const } } : {}),
      },
      distinct: ['nameEs'],
      select: { nameEs: true },
    }),
  ])
  const models = sortModels(modelRows.map((r) => r.compatibleModels!).filter(Boolean))
  const categories = catRows.map((r) => r.nameEs).filter(Boolean).sort((a, b) => a.localeCompare(b))
  return { models, categories }
}
