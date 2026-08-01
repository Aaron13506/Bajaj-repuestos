// Las motos del catálogo y cómo se muestran.
//
// `Product.models` es `MotoModel[]` (enum de Prisma). Un ensamble lleva exactamente una
// moto — esa es su identidad, y es lo único que distingue dos conjuntos con el mismo
// nombre ("Spark Plugs") que en realidad son de motos distintas. Una pieza suelta lleva
// todas las motos que la usan (hasta las 14), y de ahí sale la compatibilidad cruzada:
// la misma pastilla que sirve para la N250 y para la N160 es una sola fila.
//
// Sin campo propio en Pedido/PedidoItem: las motos se derivan del producto al mostrar,
// así el armador, el detalle y el PDF siempre dicen lo mismo.
//
// Módulo puro (sin `db`): lo importa tanto el server como el armador, que es cliente.

// ─────────────────────────────────────────────────────────────────────────────
// Las 14 motos. `id` es EXACTAMENTE el valor del enum MotoModel del schema
// (lib/catalog.ts falla la compilación si se desincronizan), así que esta tabla es la
// traducción única entre lo guardado y todo lo que se ve.
//
// Cada moto se parte en familia + variante porque así se leen: "N160 Single y Dual ABS"
// dice lo mismo que dos etiquetas de 30 caracteres y entra en una fila. Los años solo
// aparecen cuando hacen falta para desempatar dos variantes homónimas.
// ─────────────────────────────────────────────────────────────────────────────
export const MOTO_MODELS = [
  { id: 'PULSAR_150_BS4',                 label: 'Pulsar 150 BS4',                 family: '150',   variant: 'BS4',        years: null      },
  { id: 'PULSAR_150_UG4',                 label: 'Pulsar 150 UG4',                 family: '150',   variant: 'UG4',        years: null      },
  { id: 'PULSAR_180_BS3_2009_16_UG4',     label: 'Pulsar 180 BS3 2009 16 UG4',     family: '180',   variant: 'BS3 UG4',    years: '2009-16' },
  { id: 'PULSAR_180_BS4_2017_19',         label: 'Pulsar 180 BS4 2017 19',         family: '180',   variant: 'BS4',        years: '2017-19' },
  { id: 'PULSAR_200NS_BS3_2012_16',       label: 'Pulsar 200NS BS3 2012 16',       family: '200NS', variant: 'BS3',        years: '2012-16' },
  { id: 'PULSAR_NS200_BS4_2017_19',       label: 'Pulsar NS200 BS4 2017 19',       family: 'NS200', variant: 'BS4',        years: '2017-19' },
  { id: 'PULSAR_NS200_BS6_2020',          label: 'Pulsar NS200 BS6 2020',          family: 'NS200', variant: 'BS6',        years: '2020'    },
  { id: 'PULSAR_NS200_BS6_2021_23',       label: 'Pulsar NS200 BS6 2021 23',       family: 'NS200', variant: 'BS6',        years: '2021-23' },
  { id: 'PULSAR_NS200_USD_FORK_2023',     label: 'Pulsar NS200 USD Fork 2023',     family: 'NS200', variant: 'USD Fork',   years: '2023'    },
  { id: 'PULSAR_N160_SINGLE_ABS_2022_23', label: 'Pulsar N160 Single ABS 2022 23', family: 'N160',  variant: 'Single ABS', years: '2022-23' },
  { id: 'PULSAR_N160_DUAL_ABS_2022_23',   label: 'Pulsar N160 Dual ABS 2022 23',   family: 'N160',  variant: 'Dual ABS',   years: '2022-23' },
  { id: 'PULSAR_N250_SINGLE_ABS_2021_23', label: 'Pulsar N250 Single ABS 2021 23', family: 'N250',  variant: 'Single ABS', years: '2021-23' },
  { id: 'PULSAR_N250_DUAL_ABS_2022_23',   label: 'Pulsar N250 Dual ABS 2022 23',   family: 'N250',  variant: 'Dual ABS',   years: '2022-23' },
  { id: 'PULSAR_N250_USD_FORK_2024_25',   label: 'Pulsar N250 USD Fork 2024 25',   family: 'N250',  variant: 'USD Fork',   years: '2024-25' },
] as const

/** El id del enum MotoModel de Prisma, como unión de literales. */
export type MotoModelId = typeof MOTO_MODELS[number]['id']
export type MotoFamily = typeof MOTO_MODELS[number]['family']
export type MotoModelInfo = typeof MOTO_MODELS[number]

export const ALL_MODELS: readonly MotoModelInfo[] = MOTO_MODELS

const BY_ID = new Map<string, MotoModelInfo>(MOTO_MODELS.map(m => [m.id, m]))
const BY_LABEL = new Map<string, MotoModelInfo>(MOTO_MODELS.map(m => [m.label, m]))
const ORDER = new Map<string, number>(MOTO_MODELS.map((m, i) => [m.id, i]))

/** true si el string es uno de los 14 ids del enum (para validar entrada externa). */
export function isMotoModelId(v: unknown): v is MotoModelId {
  return typeof v === 'string' && BY_ID.has(v)
}

/** La moto tipada a partir de su id. */
export function modelById(id: string | null | undefined): MotoModelInfo | null {
  return id ? BY_ID.get(id) ?? null : null
}

/** Orden de catálogo (por cilindrada/familia), sin repetidos. */
export function sortModels(ids: readonly string[]): MotoModelId[] {
  return MOTO_MODELS.filter(m => ids.includes(m.id)).map(m => m.id)
}

// Variantes que se repiten dentro de una familia (NS200 BS6 2020 y NS200 BS6 2021-23):
// solo esas necesitan el año para no ser el mismo texto dos veces.
const NEEDS_YEAR = new Set(
  MOTO_MODELS.filter(m => MOTO_MODELS.some(o => o !== m && o.family === m.family && o.variant === m.variant)).map(m => m.id),
)

/** Nombre corto de UNA moto: "N160 Dual ABS". Sin "Pulsar" ni años redundantes. */
export function shortModel(id: string): string {
  const info = modelById(id)
  if (!info) return id
  const years = NEEDS_YEAR.has(info.id) && info.years ? ` ${info.years}` : ''
  return `${info.family} ${info.variant}${years}`
}

/** Nombre completo, con años: "Pulsar N160 Dual ABS 2022 23". */
export function fullModel(id: string): string {
  return modelById(id)?.label ?? id
}

/**
 * Lista de motos colapsada por familia, para leerla de un vistazo.
 *
 *   N160 Single ABS + N160 Dual ABS       → "N160 Single y Dual ABS"
 *   las 3 N250                            → "N250 (todas)"
 *   NS200 BS4 + BS6 2020 + N250 USD Fork  → "NS200 BS4 y BS6 2020 · N250 USD Fork"
 *
 * Trece etiquetas completas son 400 caracteres que no lee nadie; agrupadas son una línea.
 */
export function formatModels(ids: readonly string[]): string {
  const byFamily = new Map<string, MotoModelInfo[]>()
  for (const id of sortModels(ids)) {
    const info = BY_ID.get(id)!
    const list = byFamily.get(info.family) ?? []
    list.push(info)
    byFamily.set(info.family, list)
  }

  return [...byFamily.entries()]
    .map(([family, list]) => {
      const inFamily = MOTO_MODELS.filter(m => m.family === family)
      if (list.length === inFamily.length && inFamily.length > 1) return `${family} (todas)`

      // El año solo desempata variantes homónimas dentro de la familia — y se mira
      // contra el catálogo, no contra `list`: "NS200 BS6" a secas es ambiguo aunque en
      // esta lista venga una sola, porque en el catálogo hay dos BS6 (2020 y 2021-23).
      const variants = list.map(m => (NEEDS_YEAR.has(m.id) && m.years ? `${m.variant} ${m.years}` : m.variant))
      return `${family} ${joinVariants(variants)}`
    })
    .join(' · ')
}

/**
 * "Single ABS" + "Dual ABS" → "Single y Dual ABS": si todas las variantes terminan
 * igual, el sufijo se dice una sola vez. Es como se nombran de hecho.
 */
function joinVariants(variants: string[]): string {
  if (variants.length === 1) return variants[0]
  const words = variants.map(v => v.split(' '))
  const suffix: string[] = []
  while (words[0].length > 1 && words.every(w => w.length > 1 && w[w.length - 1] === words[0][words[0].length - 1])) {
    suffix.unshift(words[0][words[0].length - 1])
    for (const w of words) w.pop()
  }
  const heads = words.map(w => w.join(' '))
  const joined = heads.length === 2
    ? heads.join(' y ')
    : `${heads.slice(0, -1).join(', ')} y ${heads[heads.length - 1]}`
  return suffix.length ? `${joined} ${suffix.join(' ')}` : joined
}

/**
 * Las motos cuyo nombre matchea un texto libre, para el buscador del catálogo.
 *
 * Antes el buscador hacía LIKE contra el campo de texto; ahora que son enum hay que
 * traducir "n250" o "dual abs" a ids primero. Busca contra la etiqueta completa y
 * contra el nombre corto, así "N250 dual" y "Pulsar N250 Dual ABS 2022 23" entran igual.
 */
export function searchModels(term: string): MotoModelId[] {
  const q = term.trim().toLowerCase()
  if (!q) return []
  return MOTO_MODELS.filter(
    m => m.label.toLowerCase().includes(q) || shortModel(m.id).toLowerCase().includes(q),
  ).map(m => m.id)
}

// Ancho útil de un badge en las filas del carrito y del detalle, en caracteres.
const BADGE_MAX = 26

export interface ModeloLabel {
  /** Texto corto para el badge. */
  label: string
  /** Lista agrupada completa, para el tooltip. */
  full: string
  /** Cuántas motos abarca (1 ⇒ la moto identifica la línea). */
  count: number
}

export function modeloLabel(ids: readonly string[] | null | undefined): ModeloLabel | null {
  const models = sortModels(ids ?? [])
  if (models.length === 0) return null
  const full = formatModels(models)
  if (models.length === 1) return { label: shortModel(models[0]), full, count: 1 }
  // Si agrupadas por familia entran en el badge se muestran ("N160 Single y Dual ABS")
  // en vez del conteo, que no dice nada. Si no entran, conteo y el resto al tooltip.
  return { label: full.length <= BADGE_MAX ? full : `${models.length} motos`, full, count: models.length }
}

export interface CompatBadge {
  /** Las otras motos que usan la misma pieza (sin `current`), en orden de catálogo. */
  extras: MotoModelId[]
  /** Texto del badge: "+3 motos" o "solo esta moto". */
  label: string
  /** false ⇒ la pieza es exclusiva de la moto que se está mirando. */
  shared: boolean
}

/**
 * Qué OTRAS motos comparten esta pieza, mirando desde `current`.
 *
 * Es la pregunta del armado de stock: parado en la 250, ¿esta pastilla también me
 * resuelve la 160? Sin `current` (filtro "todas las motos") no hay desde-dónde y el
 * badge no aplica — ahí sirve `modeloLabel`.
 */
export function compatBadge(ids: readonly string[] | null | undefined, current: string): CompatBadge | null {
  if (!current) return null
  const models = sortModels(ids ?? [])
  if (models.length === 0) return null
  const extras = models.filter(m => m !== current)
  return {
    extras,
    label: extras.length === 0 ? 'solo esta moto' : `+${extras.length} moto${extras.length === 1 ? '' : 's'}`,
    shared: extras.length > 0,
  }
}

export interface ModelCoverage {
  model: MotoModelId
  /** Líneas del presupuesto que sirven para esta moto. */
  lines: number
  /** Unidades sumadas de esas líneas. */
  units: number
  /** De esas líneas, cuántas sirven además para otra moto. */
  shared: number
}

/**
 * Cobertura del carrito moto por moto: cuánto de lo que ya elegí le sirve a cada una.
 *
 * Una misma pieza cuenta en todas las motos que cubre — ese es el punto: ver que el
 * pedido armado "para la 250" ya deja media 160 cubierta, sin entrar a la 160 a
 * revisar. Ordenado por cobertura, de mayor a menor.
 */
export function coverageByModel(
  items: { models?: readonly string[] | null; quantity: number }[],
): ModelCoverage[] {
  const acc = new Map<string, ModelCoverage>()
  for (const item of items) {
    const models = sortModels(item.models ?? [])
    for (const model of models) {
      const row = acc.get(model) ?? { model, lines: 0, units: 0, shared: 0 }
      row.lines += 1
      row.units += item.quantity
      if (models.length > 1) row.shared += 1
      acc.set(model, row)
    }
  }
  return [...acc.values()].sort(
    (a, b) => b.lines - a.lines || (ORDER.get(a.model) ?? 99) - (ORDER.get(b.model) ?? 99),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Legado: traducción desde el viejo texto libre `Product.compatibleModels`.
// Lo usan el backfill (scripts/backfill-models.ts) y la importación por JSON, que
// sigue aceptando etiquetas además de ids. Nada de la app lee ese campo ya.
// ─────────────────────────────────────────────────────────────────────────────

/** La moto a partir de su etiqueta ("Pulsar N160 Dual ABS 2022 23"). */
export function modelByLabel(label: string | null | undefined): MotoModelInfo | null {
  return label ? BY_LABEL.get(label.trim()) ?? null : null
}

/** Separa el viejo campo de texto en entradas sueltas, sin interpretarlas. */
export function parseModels(compatibleModels: string | null | undefined): string[] {
  return (compatibleModels ?? '').split(',').map(m => m.trim()).filter(Boolean)
}

/**
 * Entrada externa (JSON de importación, API) → ids del enum.
 *
 * Acepta un array o un string separado por comas, y en cada entrada tanto el id
 * ("PULSAR_N250_DUAL_ABS_2022_23") como la etiqueta ("Pulsar N250 Dual ABS 2022 23").
 * Lo que no sea ninguna de las dos se descarta en silencio — es exactamente lo que
 * antes entraba como "Pulsar N250/N160" y ensuciaba el campo.
 */
export function toModelIds(input: unknown): MotoModelId[] {
  const entries = Array.isArray(input)
    ? input.map(v => (typeof v === 'string' ? v.trim() : ''))
    : typeof input === 'string'
      ? parseModels(input)
      : []
  const ids = entries
    .map(entry => (isMotoModelId(entry) ? entry : modelByLabel(entry)?.id))
    .filter((id): id is MotoModelId => id != null)
  return sortModels(ids)
}
