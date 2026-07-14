import { getShoppReRate } from './shipping-rates'

export type ConfigMap = Record<string, string>

export interface LandedBreakdown {
  productCostUsd: number
  shoppreShippingUsd: number
  insuranceUsd: number
  maritimeUsd: number
  landedCostUsd: number
  priceUsd: number | null
  priceBsd: number | null
}

export interface ProductForCalc {
  priceInr: number | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
}

export function calcLanded(product: ProductForCalc, cfg: ConfigMap): LandedBreakdown | null {
  if (!product.priceInr || !product.weightGrams) return null

  const inrUsd        = parseFloat(cfg.inr_usd_rate          ?? '95')
  const bsdUsd        = parseFloat(cfg.bsd_usd_rate          ?? '715')
  const isMember      = cfg.shoppre_member                   !== 'false'
  const refWeightKg   = parseFloat(cfg.reference_weight_kg   ?? '15')
  const maritimePft3  = parseFloat(cfg.miami_caracas_per_ft3 ?? '45')
  const insurancePct  = parseFloat(cfg.shoppre_insurance_pct ?? '0.03')
  const carrier       = cfg.shoppre_carrier                  ?? 'ShipGlobal USA - Duty Free'

  const productCostUsd = product.priceInr / inrUsd
  const fraction = product.weightGrams / (refWeightKg * 1000)
  const refRateInr = getShoppReRate(refWeightKg, carrier, isMember)

  const shoppreShippingUsd = (refRateInr / inrUsd) * fraction
  const insuranceUsd       = productCostUsd * insurancePct

  let maritimeUsd = 0
  if (product.dimL && product.dimA && product.dimH) {
    const volumeFt3 = (product.dimL * product.dimA * product.dimH) / 28316.846
    maritimeUsd = volumeFt3 * maritimePft3
  }

  // El processing fee de Shoppre es un cargo fijo por ENVÍO, no por pieza, así que no
  // se incluye en el costo landed por producto. Se aplica una sola vez en calcEnvio.
  const landedCostUsd = productCostUsd + shoppreShippingUsd + insuranceUsd + maritimeUsd

  // Margen efectivo: el de la pieza si lo tiene, si no el default global (Config).
  // Sin default_margin en Config, se mantiene el comportamiento anterior (sin precio).
  const globalMargin = parseFloat(cfg.default_margin ?? '')
  const margin = product.margin ?? (Number.isNaN(globalMargin) ? null : globalMargin)

  let priceUsd: number | null = null
  let priceBsd: number | null = null
  if (margin != null && margin < 1) {
    priceUsd = landedCostUsd / (1 - margin)
    priceBsd = priceUsd * bsdUsd
  }

  return {
    productCostUsd,
    shoppreShippingUsd,
    insuranceUsd,
    maritimeUsd,
    landedCostUsd,
    priceUsd,
    priceBsd,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Costeo a nivel ENVÍO (caja real)
//
// A diferencia de calcLanded (que costea una pieza aislada con prorrateo sobre un
// peso de referencia), calcEnvio toma todas las piezas de un envío y aplica el
// modelo correcto del tramo aéreo: el carrier cobra max(ΣpesoReal, Σvolumétrico)
// de toda la caja. El costo aéreo se reparte entre piezas según la dimensión que
// ata el envío (weight-bound → por peso real; volume-bound → por volumétrico),
// de modo que las piezas voluminosas y ligeras que viajan en la holgura salen
// casi gratis en aéreo cuando la caja está atada por peso.
//
// El marítimo es aditivo (ft³ por pieza) y el resto de cargos se reparten
// proporcionalmente.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvioItemInput {
  pedidoId: number
  productId: number
  name: string
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  quantity: number
}

export interface EnvioItemLine {
  pedidoId: number
  productId: number
  name: string
  quantity: number
  realKg: number          // peso real total de la línea (kg)
  volKg: number           // peso volumétrico total de la línea (kg)
  productCostUsd: number
  airUsd: number          // aéreo asignado por la dimensión que ata
  maritimeUsd: number     // su propio volumen marítimo
  landedUsd: number       // costo landed total de la línea
  missingWeight: boolean
  missingDims: boolean
}

export interface EnvioBreakdown {
  realKg: number
  volKg: number
  chargeableKg: number
  binding: 'weight' | 'volume'
  ratioVW: number | null  // V / W (utilización volumétrica)
  airInr: number
  airUsd: number
  airPerKgUsd: number     // aéreo efectivo por kg cobrable
  maritimeUsd: number
  productCostUsd: number
  insuranceUsd: number
  processingUsd: number
  landedUsd: number
  lines: EnvioItemLine[]
}

export function calcEnvio(items: EnvioItemInput[], cfg: ConfigMap): EnvioBreakdown {
  const inrUsd        = parseFloat(cfg.inr_usd_rate           ?? '95')
  const isMember      = cfg.shoppre_member                    !== 'false'
  const maritimePft3  = parseFloat(cfg.miami_caracas_per_ft3  ?? '45')
  const insurancePct  = parseFloat(cfg.shoppre_insurance_pct  ?? '0.03')
  const processingInr = parseFloat(cfg.shoppre_processing_inr ?? '500')
  const carrier       = cfg.shoppre_carrier                   ?? 'ShipGlobal USA - Duty Free'
  const divisor       = parseFloat(cfg.air_volumetric_divisor ?? '5000')

  // Primera pasada: peso real, volumétrico, costo de producto y marítimo por línea
  const lines: EnvioItemLine[] = items.map(it => {
    const qty = it.quantity
    const realKg = ((it.weightGrams ?? 0) / 1000) * qty
    const hasDims = it.dimL != null && it.dimA != null && it.dimH != null
    const cm3 = hasDims ? it.dimL! * it.dimA! * it.dimH! : 0
    const volKg = hasDims ? (cm3 / divisor) * qty : 0
    const volumeFt3 = hasDims ? (cm3 / 28316.846) * qty : 0
    return {
      pedidoId: it.pedidoId,
      productId: it.productId,
      name: it.name,
      quantity: qty,
      realKg,
      volKg,
      productCostUsd: ((it.priceInr ?? 0) / inrUsd) * qty,
      airUsd: 0,
      maritimeUsd: volumeFt3 * maritimePft3,
      landedUsd: 0,
      missingWeight: it.weightGrams == null,
      missingDims: !hasDims,
    }
  })

  const W = lines.reduce((s, l) => s + l.realKg, 0)
  const V = lines.reduce((s, l) => s + l.volKg, 0)
  const chargeableKg = Math.max(W, V)
  const binding: 'weight' | 'volume' = W >= V ? 'weight' : 'volume'

  // Aéreo total = tarifa al peso cobrable (step-function), una sola vez
  const airInr = chargeableKg > 0 ? getShoppReRate(chargeableKg, carrier, isMember) : 0
  const airUsd = airInr / inrUsd

  // Reparto del aéreo por la dimensión que ata
  const denom = binding === 'weight' ? W : V
  for (const l of lines) {
    const contrib = binding === 'weight' ? l.realKg : l.volKg
    l.airUsd = denom > 0 ? airUsd * (contrib / denom) : 0
  }

  const productCostUsd = lines.reduce((s, l) => s + l.productCostUsd, 0)
  const maritimeUsd    = lines.reduce((s, l) => s + l.maritimeUsd, 0)
  const insuranceUsd   = productCostUsd * insurancePct
  const processingUsd  = items.length > 0 ? processingInr / inrUsd : 0

  const landedUsd = productCostUsd + airUsd + insuranceUsd + processingUsd + maritimeUsd

  // Landed por línea: base directa (producto + aéreo + marítimo) + prorrateo de
  // los cargos de envío (seguro, processing) proporcional a esa base.
  const baseSum = productCostUsd + airUsd + maritimeUsd
  const overhead = insuranceUsd + processingUsd
  for (const l of lines) {
    const base = l.productCostUsd + l.airUsd + l.maritimeUsd
    l.landedUsd = base + (baseSum > 0 ? overhead * (base / baseSum) : 0)
  }

  return {
    realKg: W,
    volKg: V,
    chargeableKg,
    binding,
    ratioVW: W > 0 ? V / W : null,
    airInr,
    airUsd,
    airPerKgUsd: chargeableKg > 0 ? airUsd / chargeableKg : 0,
    maritimeUsd,
    productCostUsd,
    insuranceUsd,
    processingUsd,
    landedUsd,
    lines,
  }
}
