'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { msg, toNum, toStr } from '@/lib/parse'

export interface SupplierImportResult {
  ok: boolean
  updated: number
  skipped: { sku: string; message: string }[]
  message?: string
}

// JSON laxo: acepta array de objetos ({sku,priceUsd} o alias) o un mapa plano
// {sku: precio}. Los valores pueden venir como string o número.
interface RawPriceEntry {
  sku?: unknown
  bajajCode?: unknown
  code?: unknown
  priceUsd?: unknown
  price?: unknown
  precio?: unknown
}

// Normaliza el JSON pegado a una lista plana de {sku, priceUsd}, tolerando tanto un
// array de objetos como un mapa {sku: precio}.
function collectEntries(parsed: unknown): { sku: string; priceUsd: number | null }[] {
  if (Array.isArray(parsed)) {
    return (parsed as RawPriceEntry[]).map(it => ({
      sku: toStr(it.sku) ?? toStr(it.bajajCode) ?? toStr(it.code) ?? '',
      priceUsd: toNum(it.priceUsd) ?? toNum(it.price) ?? toNum(it.precio),
    }))
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>).map(([sku, price]) => ({
      sku: sku.trim(),
      priceUsd: toNum(price),
    }))
  }
  return []
}

export async function importSupplierPrices(
  supplierId: number,
  _prev: SupplierImportResult,
  formData: FormData,
): Promise<SupplierImportResult> {
  const raw = (formData.get('json') as string)?.trim() ?? ''
  if (!raw) return { ok: false, updated: 0, skipped: [], message: 'Pegá el JSON primero.' }
  const isLanded = formData.get('isLanded') === 'true'

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, updated: 0, skipped: [], message: `JSON inválido: ${msg(e)}` }
  }

  const rawEntries = collectEntries(parsed)
  const skipped: SupplierImportResult['skipped'] = []
  const entries: { sku: string; priceUsd: number }[] = []
  for (const e of rawEntries) {
    if (!e.sku) { skipped.push({ sku: '(sin sku)', message: 'Falta sku/bajajCode.' }); continue }
    if (e.priceUsd == null || e.priceUsd < 0) { skipped.push({ sku: e.sku, message: 'Precio (USD) inválido o faltante.' }); continue }
    entries.push({ sku: e.sku, priceUsd: e.priceUsd })
  }

  if (entries.length === 0) {
    return {
      ok: false,
      updated: 0,
      skipped,
      message: skipped.length ? 'Ningún ítem tenía sku y precio válidos.' : 'El JSON no contenía precios.',
    }
  }

  // Trae todo el catálogo con código (id + bajajCode nomás) y matchea por SKU
  // normalizado, en vez de un WHERE ... IN por cada variante de mayúsculas.
  const catalog = await db.product.findMany({
    where: { bajajCode: { not: null } },
    select: { id: true, bajajCode: true },
  })
  const bySku = new Map<string, number>()
  for (const p of catalog) {
    if (p.bajajCode) bySku.set(p.bajajCode.trim().toUpperCase(), p.id)
  }

  let updated = 0
  for (const e of entries) {
    const productId = bySku.get(e.sku.toUpperCase())
    if (productId == null) {
      skipped.push({ sku: e.sku, message: 'SKU no encontrado en el catálogo.' })
      continue
    }
    try {
      await db.supplierPrice.upsert({
        where: { productId_supplierId: { productId, supplierId } },
        update: { priceUsd: e.priceUsd, isLanded },
        create: { productId, supplierId, priceUsd: e.priceUsd, isLanded },
      })
      updated++
    } catch (err) {
      skipped.push({ sku: e.sku, message: msg(err) })
    }
  }

  if (updated > 0) {
    revalidatePath('/products')
    revalidatePath('/suppliers')
  }

  return {
    ok: skipped.length === 0,
    updated,
    skipped,
    message: `${updated} precio(s) cargado(s)${skipped.length ? `, ${skipped.length} sin coincidencia` : ''}.`,
  }
}
