'use server'

import { db } from '@/lib/db'
import { toModelIds, fullModel } from '@/lib/modelo'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { revalidatePath } from 'next/cache'

// Resultado del import que se devuelve al cliente vía useFormState.
export interface ImportResult {
  ok: boolean
  created: number
  errors: { name: string; message: string }[]
  message?: string
}

// JSON laxo: la IA puede devolver strings o números, así que normalizamos
// campo por campo. Todos los campos son opcionales salvo nameEs.
interface RawProduct {
  isAssembly?: unknown
  nameEs?: unknown
  name?: unknown            // alias tolerado
  nameEn?: unknown
  bajajCode?: unknown
  models?: unknown
  compatibleModels?: unknown   // alias tolerado: texto libre de la versión vieja
  sourceUrl?: unknown
  description?: unknown
  notes?: unknown
  priceInr?: unknown
  weightGrams?: unknown
  dimL?: unknown
  dimA?: unknown
  dimH?: unknown
  margin?: unknown          // en porcentaje, ej: 40 = 40%
  price?: unknown           // USD; si falta, se calcula desde landed + margen, o 0
  stock?: unknown
  quantity?: unknown        // cantidad del hijo dentro del ensamble
}

interface RawSubgroup {
  name?: unknown
  groupName?: unknown       // alias tolerado
  products?: unknown
}

interface RawGroup extends RawProduct {
  subgroups?: unknown
  products?: unknown        // hijos directos sin subgrupo
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.-]/g, '')) : Number(v)
  return isNaN(n) ? null : n
}

function toInt(v: unknown): number | null {
  const n = toNum(v)
  return n == null ? null : Math.round(n)
}

function toStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error desconocido.'
}

// Construye el objeto que se inserta en Prisma. Lanza si falta nameEs.
function buildProductData(it: RawProduct, cfg: ConfigMap, defaultMargin: number, forceAssembly = false) {
  const nameEs = toStr(it.nameEs) ?? toStr(it.name)
  if (!nameEs) throw new Error('Falta nameEs (nombre en español).')

  const priceInr    = toInt(it.priceInr)
  const weightGrams = toInt(it.weightGrams)
  const dimL = toNum(it.dimL)
  const dimA = toNum(it.dimA)
  const dimH = toNum(it.dimH)

  const marginPct = toNum(it.margin)
  const margin = marginPct != null ? marginPct / 100 : defaultMargin

  const breakdown = calcLanded({ priceInr, weightGrams, dimL, dimA, dimH, margin }, cfg)
  const landedCostUsd = breakdown ? round2(breakdown.landedCostUsd) : null

  // Precio: el explícito gana; si no, el calculado; si tampoco, 0 (se completa luego).
  const explicitPrice = toNum(it.price)
  const price = explicitPrice ?? (breakdown?.priceUsd != null ? round2(breakdown.priceUsd) : 0)

  return {
    isAssembly:       forceAssembly || it.isAssembly === true || it.isAssembly === 'true',
    nameEs,
    nameEn:           toStr(it.nameEn),
    bajajCode:        toStr(it.bajajCode),
    compatibleModels: toModelIds(it.models ?? it.compatibleModels).map(fullModel).join(', ') || null,
    sourceUrl:        toStr(it.sourceUrl),
    description:      toStr(it.description),
    notes:            toStr(it.notes),
    priceInr,
    weightGrams,
    dimL,
    dimA,
    dimH,
    margin:           breakdown || marginPct != null ? margin : null,
    landedCostUsd,
    price,
    stock:            toInt(it.stock) ?? 0,
  }
}

// Detecta si el JSON describe ensambles (grupos) o productos sueltos.
function collectGroups(parsed: unknown): RawGroup[] | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>
    if (o.group) return [o.group as RawGroup]
    if (Array.isArray(o.groups)) return o.groups as RawGroup[]
    if (Array.isArray(o.subgroups) || o.isAssembly === true || o.isAssembly === 'true') {
      return [o as RawGroup]
    }
    return null
  }
  if (Array.isArray(parsed) && parsed.some(e => e && typeof e === 'object' && Array.isArray((e as RawGroup).subgroups))) {
    return parsed as RawGroup[]
  }
  return null
}

export async function importProducts(
  _prev: ImportResult,
  formData: FormData,
): Promise<ImportResult> {
  const raw = (formData.get('json') as string)?.trim() ?? ''
  if (!raw) return { ok: false, created: 0, errors: [], message: 'Pegá el JSON primero.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, created: 0, errors: [], message: `JSON inválido: ${msg(e)}` }
  }

  const rows = await db.config.findMany()
  const cfg = rows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const defaultMargin = parseFloat(cfg.default_margin_pct ?? '40') / 100

  const errors: ImportResult['errors'] = []
  let created = 0

  // Crea un producto y devuelve su id (o null si falló). Registra el error con `label`.
  async function createOne(it: RawProduct, label: string, forceAssembly = false): Promise<number | null> {
    let data
    try {
      data = buildProductData(it, cfg, defaultMargin, forceAssembly)
    } catch (e) {
      errors.push({ name: label, message: msg(e) })
      return null
    }
    try {
      const p = await db.product.create({ data })
      created++
      return p.id
    } catch (e) {
      errors.push({ name: label, message: msg(e) })
      return null
    }
  }

  const groups = collectGroups(parsed)

  if (groups) {
    for (const g of groups) {
      const parentName = toStr(g.nameEs) ?? toStr(g.name) ?? 'Ensamble'
      const parentId = await createOne(g, parentName, true)
      if (parentId == null) continue

      // subgrupos explícitos, o hijos directos bajo subgrupo vacío
      const subgroups: RawSubgroup[] = Array.isArray(g.subgroups)
        ? (g.subgroups as RawSubgroup[])
        : Array.isArray(g.products)
          ? [{ name: '', products: g.products }]
          : []

      for (const sg of subgroups) {
        const groupName = toStr(sg.name) ?? toStr(sg.groupName) ?? ''
        const prods: RawProduct[] = Array.isArray(sg.products) ? (sg.products as RawProduct[]) : []
        let sortOrder = 0
        for (const child of prods) {
          const childName = toStr(child.nameEs) ?? toStr(child.name) ?? '?'
          const path = `${parentName} › ${groupName || '(sin subgrupo)'} › ${childName}`
          const childId = await createOne(child, path)
          if (childId == null) continue
          try {
            await db.productComponent.create({
              data: { parentId, childId, groupName, quantity: toInt(child.quantity) ?? 1, sortOrder: sortOrder++ },
            })
          } catch (e) {
            errors.push({ name: path, message: `Creado pero no se enlazó al ensamble: ${msg(e)}` })
          }
        }
      }
    }
  } else {
    const items: RawProduct[] = Array.isArray(parsed) ? parsed : [parsed]
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      await createOne(it, toStr(it.nameEs) ?? toStr(it.name) ?? `(item #${i + 1})`)
    }
  }

  if (created > 0) {
    revalidatePath('/products')
    revalidatePath('/groups')
  }

  return {
    ok: errors.length === 0,
    created,
    errors,
    message: created === 0 && errors.length === 0
      ? 'No se creó nada (el JSON no contenía productos).'
      : `${created} producto(s) creado(s)${errors.length ? `, ${errors.length} con error` : ''}.`,
  }
}
