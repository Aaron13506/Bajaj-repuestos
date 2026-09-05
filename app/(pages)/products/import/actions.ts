'use server'

import { db } from '@/lib/db'
import { toModelIds, fullModel } from '@/lib/modelo'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { revalidatePath } from 'next/cache'
import { getConfig } from '@/lib/config-db'
import { margenPorDefecto } from '@/lib/config'
import { msg, round2, toInt, toNum, toStr } from '@/lib/parse'

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

  const cfg = await getConfig()
  const defaultMargin = margenPorDefecto(cfg)

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

  // Las piezas de un subgrupo (o de una lista suelta) son independientes entre sí: nada de
  // lo que hace una cambia lo que hace la otra. Estaban encadenadas con `await` una por
  // una, y contra el pooler en us-west-2 eso son ~200 ms POR PIEZA en serie — un ensamble
  // de 50 partes tardaba lo mismo que 100 viajes seguidos. Se disparan juntas y el pool
  // (max 10) las va sirviendo.
  //
  // Se mantiene el create fila por fila, y NO un createMany, a propósito: el importador
  // reporta el error de cada pieza con su ruta (`Ensamble › Subgrupo › Pieza`), y en un
  // lote único un solo JSON mal formado tumbaría las otras 49 sin decir cuál fue.
  async function crearPiezas(
    prods: RawProduct[],
    etiqueta: (child: RawProduct, i: number) => string,
  ): Promise<(number | null)[]> {
    return Promise.all(prods.map((child, i) => createOne(child, etiqueta(child, i))))
  }

  if (groups) {
    for (const g of groups) {
      const parentName = toStr(g.nameEs) ?? toStr(g.name) ?? 'Ensamble'
      // El padre sí va antes que todo: los hijos necesitan su id para enlazarse.
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
        const ruta = (child: RawProduct) =>
          `${parentName} › ${groupName || '(sin subgrupo)'} › ${toStr(child.nameEs) ?? toStr(child.name) ?? '?'}`

        const childIds = await crearPiezas(prods, ruta)

        // sortOrder sale del índice en el JSON, no de un contador que avanza al escribir:
        // así el orden es el del documento y no el de quién terminó primero.
        const enlaces = childIds
          .map((childId, i) => ({ childId, child: prods[i], sortOrder: i }))
          .filter((e): e is { childId: number; child: RawProduct; sortOrder: number } => e.childId != null)

        await Promise.all(enlaces.map(async e => {
          try {
            await db.productComponent.create({
              data: {
                parentId,
                childId: e.childId,
                groupName,
                quantity: toInt(e.child.quantity) ?? 1,
                sortOrder: e.sortOrder,
              },
            })
          } catch (err) {
            errors.push({ name: ruta(e.child), message: `Creado pero no se enlazó al ensamble: ${msg(err)}` })
          }
        }))
      }
    }
  } else {
    const items: RawProduct[] = Array.isArray(parsed) ? parsed : [parsed]
    await crearPiezas(items, (it, i) => toStr(it.nameEs) ?? toStr(it.name) ?? `(item #${i + 1})`)
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
