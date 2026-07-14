'use server'

import { db } from '@/lib/db'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { revalidatePath } from 'next/cache'

// Resultado del update de medidas, devuelto al cliente vía useFormState.
export interface MeasuresResult {
  ok: boolean
  updated: number       // filas de Product actualizadas
  priced: number        // de esas, cuántas quedaron con precio recalculado (> 0)
  notFound: string[]    // identificadores que no matchearon ningún producto
  errors: { name: string; message: string }[]
  message?: string
}

// JSON laxo: la IA puede devolver strings o números. Cada fila identifica un
// producto existente (por id o bajajCode) y trae SOLO los campos físicos a cargar.
interface RawMeasure {
  id?: unknown
  bajajCode?: unknown
  sku?: unknown             // alias tolerado de bajajCode
  code?: unknown            // alias tolerado de bajajCode
  weightGrams?: unknown
  weight?: unknown          // alias tolerado (gramos)
  dimL?: unknown
  dimA?: unknown
  dimH?: unknown
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

// Extrae el JSON de una respuesta que puede traer razonamiento y fuentes alrededor.
// Prefiere un bloque cercado ```json … ```; si no, balancea desde el primer [ o {
// (respetando strings), así se puede pegar la respuesta completa de la IA.
function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const src = fence ? fence[1] : raw
  const iArr = src.indexOf('[')
  const iObj = src.indexOf('{')
  let start = -1
  if (iArr >= 0 && (iObj < 0 || iArr < iObj)) start = iArr
  else if (iObj >= 0) start = iObj
  if (start < 0) return src.trim()
  const open = src[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0, inStr = false, esc = false
  for (let j = start; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return src.slice(start, j + 1)
  }
  return src.slice(start).trim()
}

// Normaliza la entrada a un array de filas, tolerando {items:[...]}, un objeto suelto,
// o un array directo.
function collectRows(parsed: unknown): RawMeasure[] {
  if (Array.isArray(parsed)) return parsed as RawMeasure[]
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.items)) return o.items as RawMeasure[]
    if (Array.isArray(o.products)) return o.products as RawMeasure[]
    if (Array.isArray(o.measures)) return o.measures as RawMeasure[]
    return [parsed as RawMeasure]
  }
  return []
}

// Precio del conjunto: fija (o limpia) el precio de venta del ensamble como una
// unidad. Con `priceLocked` activo se usa como precio único al venderlo como conjunto
// en presupuestos, y ningún recálculo lo pisa. Sin precio o desmarcado, se libera.
export async function setBundlePrice(id: number, formData: FormData) {
  const priceStr = (formData.get('price') as string)?.trim() ?? ''
  const locked = formData.get('priceLocked') === 'true'
  const parsed = priceStr ? parseFloat(priceStr) : 0
  const price = isNaN(parsed) || parsed < 0 ? 0 : round2(parsed)

  await db.product.update({
    where: { id },
    data: { price, priceLocked: locked && price > 0 },
  })

  revalidatePath('/products')
  revalidatePath('/groups')
  revalidatePath(`/products/${id}`)
  revalidatePath('/presupuestos')
}

export async function updateMeasures(
  _prev: MeasuresResult,
  formData: FormData,
): Promise<MeasuresResult> {
  const raw = (formData.get('json') as string)?.trim() ?? ''
  if (!raw) return { ok: false, updated: 0, priced: 0, notFound: [], errors: [], message: 'Pegá el JSON primero.' }

  let parsed: unknown
  try {
    // La respuesta puede traer razonamiento/fuentes: extraemos el JSON embebido.
    parsed = JSON.parse(extractJson(raw))
  } catch (e) {
    return { ok: false, updated: 0, priced: 0, notFound: [], errors: [], message: `JSON inválido: ${msg(e)}` }
  }

  const rows = collectRows(parsed)
  if (rows.length === 0) {
    return { ok: false, updated: 0, priced: 0, notFound: [], errors: [], message: 'El JSON no contenía filas.' }
  }

  const cfgRows = await db.config.findMany()
  const cfg = cfgRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const defaultMargin = parseFloat(cfg.default_margin_pct ?? '40') / 100

  let updated = 0
  let priced = 0
  const notFound: string[] = []
  const errors: MeasuresResult['errors'] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const idNum = toInt(r.id)
    const code = toStr(r.bajajCode) ?? toStr(r.sku) ?? toStr(r.code)
    const label = idNum != null ? `id ${idNum}` : code ?? `(fila #${i + 1})`

    // Solo los campos presentes se actualizan; los omitidos conservan su valor.
    const patch: { weightGrams?: number | null; dimL?: number | null; dimA?: number | null; dimH?: number | null } = {}
    if ('weightGrams' in r || 'weight' in r) patch.weightGrams = toInt(r.weightGrams ?? r.weight)
    if ('dimL' in r) patch.dimL = toNum(r.dimL)
    if ('dimA' in r) patch.dimA = toNum(r.dimA)
    if ('dimH' in r) patch.dimH = toNum(r.dimH)

    if (Object.keys(patch).length === 0) {
      errors.push({ name: label, message: 'Sin campos de peso/dimensiones para actualizar.' })
      continue
    }
    if (idNum == null && !code) {
      errors.push({ name: label, message: 'Falta identificador (id o bajajCode).' })
      continue
    }

    try {
      // id es único; bajajCode puede aparecer en varios productos (mismo SKU reusado).
      const targets = idNum != null
        ? await db.product.findMany({ where: { id: idNum } })
        : await db.product.findMany({ where: { bajajCode: code! } })

      if (targets.length === 0) {
        notFound.push(label)
        continue
      }

      for (const p of targets) {
        const merged = {
          priceInr:    p.priceInr,
          weightGrams: patch.weightGrams !== undefined ? patch.weightGrams : p.weightGrams,
          dimL:        patch.dimL !== undefined ? patch.dimL : p.dimL,
          dimA:        patch.dimA !== undefined ? patch.dimA : p.dimA,
          dimH:        patch.dimH !== undefined ? patch.dimH : p.dimH,
        }

        // Margen efectivo: el de la pieza si lo tiene, si no el default global (33%).
        const effMargin = p.margin ?? defaultMargin
        const breakdown = calcLanded({ ...merged, margin: effMargin }, cfg)

        const data: Record<string, unknown> = { ...merged }
        if (p.priceLocked) {
          // Precio fijo: no se toca `price`. Se reajusta el margen para que sea
          // coherente con el nuevo costo landed (margen = 1 − landed/precio).
          if (breakdown) {
            data.landedCostUsd = round2(breakdown.landedCostUsd)
            const price = Number(p.price)
            if (price > 0) data.margin = +(1 - breakdown.landedCostUsd / price).toFixed(4)
          }
        } else {
          // Sin precio fijo: se PERSISTE el margen efectivo (el de la pieza o el default
          // global) para que quede visible, aunque no haya precio calculable todavía.
          if (Number.isFinite(effMargin)) data.margin = effMargin
          if (breakdown) {
            data.landedCostUsd = round2(breakdown.landedCostUsd)
            if (breakdown.priceUsd != null) {
              data.price = round2(breakdown.priceUsd)
              priced++
            }
          }
        }

        await db.product.update({ where: { id: p.id }, data })
        updated++
      }
    } catch (e) {
      errors.push({ name: label, message: msg(e) })
    }
  }

  if (updated > 0) {
    revalidatePath('/products')
    revalidatePath('/groups')
    // Revalida la ficha del ensamble desde donde se cargó (para ver precios nuevos).
    const revalidate = toInt(formData.get('assemblyId'))
    if (revalidate != null) revalidatePath(`/products/${revalidate}`)
  }

  const parts: string[] = []
  parts.push(`${updated} producto(s) actualizado(s)`)
  if (priced > 0) parts.push(`${priced} con precio recalculado`)
  if (notFound.length > 0) parts.push(`${notFound.length} no encontrado(s)`)
  if (errors.length > 0) parts.push(`${errors.length} con error`)

  return {
    ok: errors.length === 0 && notFound.length === 0,
    updated,
    priced,
    notFound,
    errors,
    message: parts.join(', ') + '.',
  }
}
