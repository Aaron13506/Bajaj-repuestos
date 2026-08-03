import { getShoppReRateUsd } from './shipping-rates'

export type ConfigMap = Record<string, string>

// cm³ en un pie cúbico. El marítimo cotiza por ft³, pero las medidas de las piezas
// se cargan en cm, así que toda conversión de volumen pasa por acá.
export const CM3_PER_FT3 = 28316.846

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
  // Costo del producto ya en USD (proveedores que no cotizan en ₹, ej. no son 99rpm).
  // Si está presente tiene prioridad sobre priceInr — se salta la conversión INR/USD,
  // pero Shoppre + seguro + marítimo se siguen sumando igual sobre este costo, salvo
  // que priceIsLanded sea true (ver abajo).
  priceUsd?: number | null
  // Si priceUsd ya es el costo landed final (proveedor que cotiza puesto en Venezuela,
  // ej. no hay que sumarle Shoppre/seguro/marítimo encima) — landedCostUsd = priceUsd
  // tal cual. No tiene efecto si priceUsd es null (se usa priceInr como siempre).
  priceIsLanded?: boolean
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
}

function applyMargin(landedCostUsd: number, margin: number | null, cfg: ConfigMap): { priceUsd: number | null; priceBsd: number | null } {
  const bsdUsd = parseFloat(cfg.bsd_usd_rate ?? '715')
  // Margen efectivo: el de la pieza si lo tiene, si no el default global (Config).
  // Sin default_margin en Config, se mantiene el comportamiento anterior (sin precio).
  const globalMargin = parseFloat(cfg.default_margin ?? '')
  const effectiveMargin = margin ?? (Number.isNaN(globalMargin) ? null : globalMargin)

  if (effectiveMargin == null || effectiveMargin >= 1) return { priceUsd: null, priceBsd: null }
  const priceUsd = landedCostUsd / (1 - effectiveMargin)
  return { priceUsd, priceBsd: priceUsd * bsdUsd }
}

export function calcLanded(product: ProductForCalc, cfg: ConfigMap): LandedBreakdown | null {
  const hasCost = product.priceUsd != null || !!product.priceInr
  if (!hasCost) return null

  // Proveedor que ya cotiza landed (puesto en Venezuela): el precio es el costo final,
  // sin sumarle Shoppre/seguro/marítimo — esos ya están incluidos en su cotización.
  if (product.priceIsLanded && product.priceUsd != null) {
    const landedCostUsd = product.priceUsd
    const { priceUsd, priceBsd } = applyMargin(landedCostUsd, product.margin, cfg)
    return {
      productCostUsd: landedCostUsd,
      shoppreShippingUsd: 0,
      insuranceUsd: 0,
      maritimeUsd: 0,
      landedCostUsd,
      priceUsd,
      priceBsd,
    }
  }

  if (!product.weightGrams) return null

  const inrUsd        = parseFloat(cfg.inr_usd_rate          ?? '95')
  const isMember      = cfg.shoppre_member                   !== 'false'
  const refWeightKg   = parseFloat(cfg.reference_weight_kg   ?? '15')
  const maritimePft3  = parseFloat(cfg.miami_caracas_per_ft3 ?? '45')
  const insurancePct  = parseFloat(cfg.shoppre_insurance_pct ?? '0.03')
  const carrier       = cfg.shoppre_carrier                  ?? 'ShipGlobal USA - Duty Free'

  const productCostUsd = product.priceUsd != null ? product.priceUsd : product.priceInr! / inrUsd
  const fraction = product.weightGrams / (refWeightKg * 1000)
  // Shoppre cotiza el flete en USD: la tarifa entra tal cual, sin pasar por inr_usd_rate.
  const refRateUsd = getShoppReRateUsd(refWeightKg, carrier, isMember, cfg)

  const shoppreShippingUsd = refRateUsd * fraction
  const insuranceUsd       = productCostUsd * insurancePct

  let maritimeUsd = 0
  if (product.dimL && product.dimA && product.dimH) {
    const volumeFt3 = (product.dimL * product.dimA * product.dimH) / CM3_PER_FT3
    maritimeUsd = volumeFt3 * maritimePft3
  }

  // El processing fee de Shoppre es un cargo fijo por ENVÍO, no por pieza, así que no
  // se incluye en el costo landed por producto. Se aplica una sola vez en calcEnvio.
  const landedCostUsd = productCostUsd + shoppreShippingUsd + insuranceUsd + maritimeUsd
  const { priceUsd, priceBsd } = applyMargin(landedCostUsd, product.margin, cfg)

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
  // Costo ya en USD (proveedor no-99rpm) — tiene prioridad sobre priceInr, igual que en calcLanded.
  priceUsd?: number | null
  quantity: number
  // Ruta de entrada. 'india' paga la tabla escalón de ShipGlobal; 'china' paga el costo
  // real del tramo a USA (inboundChinaUsd, prorrateado). Los dos cruzan el marítimo.
  origen?: 'india' | 'china'
  // Proveedor que cotizó puesto en Venezuela: la pieza no viaja en esta caja. Queda
  // fuera del peso, del volumen y de todos los cargos — su priceUsd YA es el landed.
  isLanded?: boolean
}

export interface EnvioItemLine {
  pedidoId: number
  productId: number
  name: string
  quantity: number
  origen: 'india' | 'china'
  isLanded: boolean
  realKg: number          // peso real total de la línea (kg)
  volKg: number           // peso volumétrico total de la línea (kg)
  ft3: number             // volumen real total de la línea (ft³), el que cobra el marítimo
  productCostUsd: number
  airUsd: number          // costo de llegar a USA (ShipGlobal si India, inbound si China)
  maritimeUsd: number     // su propio volumen marítimo
  landedUsd: number       // costo landed total de la línea
  missingWeight: boolean
  missingDims: boolean
}

// Métricas de un tramo hacia USA (India o China por separado): el carrier cobra
// max(ΣpesoReal, Σvolumétrico) del grupo, no de la caja entera.
export interface LegBreakdown {
  items: number
  realKg: number
  volKg: number
  chargeableKg: number
  binding: 'weight' | 'volume'
  ratioVW: number | null  // V / W (utilización volumétrica)
  costUsd: number
  costPerKgUsd: number
}

export interface EnvioBreakdown {
  // Tramos a USA, medidos por separado porque cotizan distinto.
  air: LegBreakdown                     // India → USA (ShipGlobal, tabla escalón en USD)
  china: LegBreakdown                   // China → USA (costo real cargado a mano)
  // Totales de la caja que cruza a Venezuela (India + China; los isLanded no viajan).
  realKg: number
  volKg: number
  chargeableKg: number
  // Volumen físico de la caja. El volumétrico (volKg) es una tarifa aérea; esto es el
  // espacio que ocupa de verdad, que es lo que cobra el marítimo y lo que hay que
  // guardar en el depósito.
  ft3: number
  binding: 'weight' | 'volume'
  ratioVW: number | null
  airUsd: number          // total a USA por los dos orígenes
  airPerKgUsd: number
  maritimeUsd: number
  productCostUsd: number
  insuranceUsd: number
  processingUsd: number
  landedUsd: number
  // Ítems que no viajan en la caja (proveedor landed): su costo entra al total pero
  // no toca peso, volumen ni cargos de flete.
  landedDirectUsd: number
  lines: EnvioItemLine[]
}

export interface EnvioOptions {
  // Costo real facturado del tramo China → USA. Se prorratea entre los ítems de ese
  // origen; sin este dato el tramo cuenta 0 y el envío se subcostea (la UI avisa).
  inboundChinaUsd?: number | null
}

// Mide un grupo de líneas como caja independiente: peso real, volumétrico, cuál de los
// dos ata, y reparte `costUsd` entre las líneas según la dimensión que ata. Así una
// pieza voluminosa y liviana viaja casi gratis cuando el grupo está atado por peso.
function repartirTramo(lines: EnvioItemLine[], costUsd: number): LegBreakdown {
  const realKg = lines.reduce((s, l) => s + l.realKg, 0)
  const volKg = lines.reduce((s, l) => s + l.volKg, 0)
  const chargeableKg = Math.max(realKg, volKg)
  const binding: 'weight' | 'volume' = realKg >= volKg ? 'weight' : 'volume'

  const denom = binding === 'weight' ? realKg : volKg
  for (const l of lines) {
    const contrib = binding === 'weight' ? l.realKg : l.volKg
    l.airUsd = denom > 0 ? costUsd * (contrib / denom) : 0
  }

  return {
    items: lines.length,
    realKg,
    volKg,
    chargeableKg,
    binding,
    ratioVW: realKg > 0 ? volKg / realKg : null,
    costUsd,
    costPerKgUsd: chargeableKg > 0 ? costUsd / chargeableKg : 0,
  }
}

export function calcEnvio(items: EnvioItemInput[], cfg: ConfigMap, opts: EnvioOptions = {}): EnvioBreakdown {
  const inrUsd        = parseFloat(cfg.inr_usd_rate           ?? '95')
  const isMember      = cfg.shoppre_member                    !== 'false'
  const maritimePft3  = parseFloat(cfg.miami_caracas_per_ft3  ?? '45')
  const insurancePct  = parseFloat(cfg.shoppre_insurance_pct  ?? '0.03')
  const processingInr = parseFloat(cfg.shoppre_processing_inr ?? '500')
  const carrier       = cfg.shoppre_carrier                   ?? 'ShipGlobal USA - Duty Free'
  const divisor       = parseFloat(cfg.air_volumetric_divisor ?? '5000')

  // Primera pasada: peso real, volumétrico, costo de producto y marítimo por línea.
  // Los ítems landed (ya puestos en Venezuela) no viajan: van con peso y volumen en
  // cero para que no inflen una caja en la que nunca estuvieron.
  const lines: EnvioItemLine[] = items.map(it => {
    const qty = it.quantity
    const isLanded = it.isLanded ?? false
    const origen = it.origen ?? 'india'
    const hasDims = it.dimL != null && it.dimA != null && it.dimH != null
    const cm3 = hasDims ? it.dimL! * it.dimA! * it.dimH! : 0
    const viaja = !isLanded
    const volumeFt3 = viaja && hasDims ? (cm3 / CM3_PER_FT3) * qty : 0
    return {
      pedidoId: it.pedidoId,
      productId: it.productId,
      name: it.name,
      quantity: qty,
      origen,
      isLanded,
      realKg: viaja ? ((it.weightGrams ?? 0) / 1000) * qty : 0,
      volKg: viaja && hasDims ? (cm3 / divisor) * qty : 0,
      ft3: volumeFt3,
      productCostUsd: (it.priceUsd != null ? it.priceUsd : (it.priceInr ?? 0) / inrUsd) * qty,
      airUsd: 0,
      maritimeUsd: volumeFt3 * maritimePft3,
      landedUsd: 0,
      // Un ítem que no viaja no "le falta" peso ni dimensiones: no se le piden.
      missingWeight: viaja && it.weightGrams == null,
      missingDims: viaja && !hasDims,
    }
  })

  const enBarco = lines.filter(l => !l.isLanded)
  const indiaLines = enBarco.filter(l => l.origen === 'india')
  const chinaLines = enBarco.filter(l => l.origen === 'china')

  // Tramo India→USA: tarifa escalón de ShipGlobal sobre el peso cobrable de ESE grupo.
  const indiaChargeable = Math.max(
    indiaLines.reduce((s, l) => s + l.realKg, 0),
    indiaLines.reduce((s, l) => s + l.volKg, 0),
  )
  const airRateUsd = indiaChargeable > 0 ? getShoppReRateUsd(indiaChargeable, carrier, isMember, cfg) : 0
  const airLeg = repartirTramo(indiaLines, airRateUsd)

  // Tramo China→USA: no hay tabla, es el costo real facturado.
  const chinaLeg = repartirTramo(chinaLines, opts.inboundChinaUsd ?? 0)

  // Totales de la caja marítima: los dos orígenes viajan juntos de USA a Venezuela.
  const W = enBarco.reduce((s, l) => s + l.realKg, 0)
  const V = enBarco.reduce((s, l) => s + l.volKg, 0)
  const chargeableKg = Math.max(W, V)
  const binding: 'weight' | 'volume' = W >= V ? 'weight' : 'volume'
  const airUsd = airLeg.costUsd + chinaLeg.costUsd

  const landedDirectUsd = lines.filter(l => l.isLanded).reduce((s, l) => s + l.productCostUsd, 0)
  const productCostUsd  = lines.reduce((s, l) => s + l.productCostUsd, 0)
  const maritimeUsd     = enBarco.reduce((s, l) => s + l.maritimeUsd, 0)
  // Seguro y processing solo sobre lo que efectivamente viaja: el costo de los ítems
  // landed ya trae todos sus cargos incluidos en la cotización del proveedor.
  const insuranceUsd    = (productCostUsd - landedDirectUsd) * insurancePct
  // El processing es un cargo fijo de Shoppre: solo aplica si hay algo saliendo de India.
  const processingUsd   = indiaLines.length > 0 ? processingInr / inrUsd : 0

  const landedUsd = productCostUsd + airUsd + insuranceUsd + processingUsd + maritimeUsd

  // Landed por línea: base directa (producto + tramo a USA + marítimo) + prorrateo de
  // los cargos de envío (seguro, processing) proporcional a esa base. Las líneas que no
  // viajan se quedan con su costo tal cual, sin prorrateo.
  const baseSum = enBarco.reduce((s, l) => s + l.productCostUsd + l.airUsd + l.maritimeUsd, 0)
  const overhead = insuranceUsd + processingUsd
  for (const l of lines) {
    if (l.isLanded) {
      l.landedUsd = l.productCostUsd
      continue
    }
    const base = l.productCostUsd + l.airUsd + l.maritimeUsd
    l.landedUsd = base + (baseSum > 0 ? overhead * (base / baseSum) : 0)
  }

  return {
    air: airLeg,
    china: chinaLeg,
    realKg: W,
    volKg: V,
    chargeableKg,
    ft3: enBarco.reduce((s, l) => s + l.ft3, 0),
    binding,
    ratioVW: W > 0 ? V / W : null,
    airUsd,
    airPerKgUsd: chargeableKg > 0 ? airUsd / chargeableKg : 0,
    maritimeUsd,
    productCostUsd,
    insuranceUsd,
    processingUsd,
    landedUsd,
    landedDirectUsd,
    lines,
  }
}
