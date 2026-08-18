import { db } from './db'
import {
  calcEnvio,
  CM3_PER_FT3,
  type ConfigMap,
  type EnvioBreakdown,
  type EnvioItemInput,
} from './calc'

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de peso y volumen a partir de una lista de SKU.
//
// El cálculo real vive en `calcEnvio`: acá solo se resuelve `bajajCode` → Product
// y se arma el `EnvioItemInput[]`. Así una consulta suelta (¿cuánto pesa este
// presupuesto?) y la página de envíos dan exactamente el mismo número, con las
// mismas tarifas de `Config` — sin constantes duplicadas ni scripts ad-hoc.
// ─────────────────────────────────────────────────────────────────────────────

export interface SkuLine {
  sku: string
  qty?: number
  origen?: 'india' | 'china'
  isLanded?: boolean
}

export interface ResolvedProduct {
  id: number
  bajajCode: string | null
  nameEs: string
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  stock: number
}

export interface VolumeMetrics {
  cm3: number
  ft3: number
  cbm: number
}

export interface QuoteMetrics {
  breakdown: EnvioBreakdown
  volume: VolumeMetrics
  /** Volumen por línea, en el mismo orden que `breakdown.lines`. */
  lineVolume: VolumeMetrics[]
  /** SKU pedidos que no existen en la BD. */
  notFound: string[]
  /** Unidades totales (suma de cantidades resueltas). */
  units: number
  cfg: ConfigMap
}

export async function loadConfig(): Promise<ConfigMap> {
  const rows = await db.config.findMany()
  return rows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
}

export function volumeOf(p: Pick<ResolvedProduct, 'dimL' | 'dimA' | 'dimH'>, qty = 1): VolumeMetrics {
  const hasDims = p.dimL != null && p.dimA != null && p.dimH != null
  const cm3 = hasDims ? p.dimL! * p.dimA! * p.dimH! * qty : 0
  return { cm3, ft3: cm3 / CM3_PER_FT3, cbm: cm3 / 1_000_000 }
}

/**
 * Busca los productos por `bajajCode`. La comparación es exacta pero
 * case-insensitive: los SKU llegan de PDFs y planillas con mayúsculas
 * inconsistentes, y un fallo silencioso acá se ve como "pesa menos".
 */
export async function resolveSkus(skus: string[]): Promise<Map<string, ResolvedProduct>> {
  const wanted = [...new Set(skus.map(s => s.trim()).filter(Boolean))]
  if (wanted.length === 0) return new Map()

  const products = await db.product.findMany({
    where: { OR: wanted.map(sku => ({ bajajCode: { equals: sku, mode: 'insensitive' as const } })) },
    select: {
      id: true, bajajCode: true, nameEs: true, weightGrams: true,
      dimL: true, dimA: true, dimH: true, priceInr: true, stock: true,
    },
  })

  const byUpper = new Map<string, ResolvedProduct>()
  for (const p of products) {
    if (p.bajajCode) byUpper.set(p.bajajCode.toUpperCase(), p)
  }

  const out = new Map<string, ResolvedProduct>()
  for (const sku of wanted) {
    const hit = byUpper.get(sku.toUpperCase())
    if (hit) out.set(sku, hit)
  }
  return out
}

export async function quoteMetrics(
  lines: SkuLine[],
  opts: { inboundChinaUsd?: number | null; cfg?: ConfigMap } = {},
): Promise<QuoteMetrics> {
  const cfg = opts.cfg ?? await loadConfig()
  const found = await resolveSkus(lines.map(l => l.sku))

  const notFound: string[] = []
  const items: EnvioItemInput[] = []
  const volumes: VolumeMetrics[] = []
  let units = 0

  for (const line of lines) {
    const p = found.get(line.sku.trim())
    if (!p) { notFound.push(line.sku); continue }

    const qty = line.qty ?? 1
    units += qty
    // Un ítem landed no viaja en la caja, así que tampoco aporta volumen al marítimo.
    volumes.push(line.isLanded ? { cm3: 0, ft3: 0, cbm: 0 } : volumeOf(p, qty))
    items.push({
      pedidoId: 0,
      productId: p.id,
      name: `${p.bajajCode ?? '—'} · ${p.nameEs}`,
      weightGrams: p.weightGrams,
      dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
      priceInr: p.priceInr,
      quantity: qty,
      origen: line.origen ?? 'india',
      isLanded: line.isLanded ?? false,
    })
  }

  const breakdown = calcEnvio(items, cfg, { inboundChinaUsd: opts.inboundChinaUsd })
  const volume = volumes.reduce<VolumeMetrics>(
    (acc, v) => ({ cm3: acc.cm3 + v.cm3, ft3: acc.ft3 + v.ft3, cbm: acc.cbm + v.cbm }),
    { cm3: 0, ft3: 0, cbm: 0 },
  )

  return { breakdown, volume, lineVolume: volumes, notFound, units, cfg }
}
