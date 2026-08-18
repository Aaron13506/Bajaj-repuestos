import { db } from './db'
import { MOTO_MODELS, modelById, modelByLabel, type MotoModelInfo } from './modelo'

// Orden lógico de los modelos (por cilindrada/familia) para los dropdowns de filtro.
// Los valores son las etiquetas legibles tal como se guardan en Product.compatibleModels.
//
// Sale de MOTO_MODELS (lib/modelo.ts) en vez de repetir la lista acá: esa tabla ya es la
// única descripción de las motos del catálogo, y tener dos copias garantizaba que se
// desincronizaran — pasó con la Boxer, que entró en una y no en la otra.
export const MODEL_ORDER: string[] = MOTO_MODELS.map(m => m.label)

export function sortModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const ia = MODEL_ORDER.indexOf(a)
    const ib = MODEL_ORDER.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b)
  })
}

/**
 * Filtro por moto sobre el texto de `compatibleModels`.
 *
 * Acepta tanto el id (`PULSAR_N250_DUAL_ABS_2022_23`) como la etiqueta: el dropdown pone
 * el id en la URL —no lleva espacios ni acentos, así que el link es limpio y estable— y
 * acá se traduce a la etiqueta, que es lo que realmente está guardado.
 *
 * Es un `contains` y no una comparación exacta porque un producto puede servir a varias
 * motos y las guarda separadas por comas. Buscar la etiqueta suelta dentro del string es
 * exacto igual: ninguna de las 15 etiquetas es substring de otra (verificado; "Pulsar
 * NS200 BS6 2020" no cae dentro de "Pulsar NS200 BS6 2021 23"). Si alguna vez se agrega
 * una que sí lo sea, esto deja de ser exacto y hay que pasar a matchear por elemento.
 */
export function whereModel(model?: string) {
  const info = modelById(model) ?? modelByLabel(model)
  return info
    ? { compatibleModels: { contains: info.label, mode: 'insensitive' as const } }
    : {}
}

// Opciones para los filtros del catálogo, derivadas de los ensambles reales:
//  - models: los modelos distintos. Casi todo ensamble tiene UNO solo, pero algunos
//    sirven para varias motos a la vez (los accesorios N250/N160), y esos guardan la
//    lista separada por comas. Por eso se parte y se aplana en vez de tomar el string
//    entero: si no, un ensamble multi-modelo aparecería como una opción de dropdown con
//    tres motos pegadas, que no matchea nada al filtrar.
//  - categories: las categorías (nameEs del ensamble, ej "Swing Arm") — SCOPEADAS al
//    modelo si se pasa uno, para que Categoría muestre solo las de ese modelo (cascada).
export async function getCatalogFilters(model?: string): Promise<{ models: MotoModelInfo[]; categories: string[] }> {
  const [modelRows, catRows] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: true, compatibleModels: { not: null } },
      distinct: ['compatibleModels'],
      select: { compatibleModels: true },
    }),
    db.product.findMany({
      where: { isAssembly: true, ...whereModel(model) },
      distinct: ['nameEs'],
      select: { nameEs: true },
    }),
  ])
  // Las etiquetas presentes se resuelven contra la tabla de motos: lo que no matchea es
  // texto viejo o mal escrito y no puede ser una opción del dropdown, porque al elegirla
  // el filtro no devolvería nada. Se ordenan por MOTO_MODELS, que ya está por cilindrada.
  const presentes = new Set(
    modelRows.flatMap((r) => (r.compatibleModels ?? '').split(',')).map((m) => m.trim()).filter(Boolean)
  )
  const models = MOTO_MODELS.filter((m) => presentes.has(m.label))
  const categories = catRows.map((r) => r.nameEs).filter(Boolean).sort((a, b) => a.localeCompare(b))
  return { models, categories }
}
