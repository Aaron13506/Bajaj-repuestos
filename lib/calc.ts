import { getShoppReRateUsd } from './shipping-rates'

export type ConfigMap = Record<string, string>

// Lee una key numérica de Config, cayendo a `fallback` si está vacía o no es número.
// Las keys del modo marítimo pueden no existir todavía en la DB (es un escenario futuro),
// así que ninguna puede romper el cálculo por ausencia.
function num(cfg: ConfigMap, key: string, fallback: number): number {
  const v = parseFloat(cfg[key] ?? '')
  return Number.isFinite(v) ? v : fallback
}

// cm³ en un pie cúbico. El marítimo cotiza por ft³, pero las medidas de las piezas
// se cargan en cm, así que toda conversión de volumen pasa por acá.
export const CM3_PER_FT3 = 28316.846

export interface LandedBreakdown {
  modo: ModoEnvio
  productCostUsd: number
  shoppreShippingUsd: number   // 0 en marítimo: no hay tramo aéreo
  insuranceUsd: number
  maritimeUsd: number
  landedCostUsd: number
  priceUsd: number | null
  priceBsd: number | null
  // ── Solo modo CBM ──────────────────────────────────────────────────────────
  // Volumen de la pieza y qué fracción del embarque de referencia ocupa. Es el dato
  // que permite ver "cuánto llena" una pieza o un ensamble sin abrir un envío.
  volumeM3: number | null
  cbmFillPct: number | null
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

export function calcLanded(
  product: ProductForCalc,
  cfg: ConfigMap,
  modo: ModoEnvio = 'aereo',
): LandedBreakdown | null {
  const hasCost = product.priceUsd != null || !!product.priceInr
  if (!hasCost) return null

  // Proveedor que ya cotiza landed (puesto en Venezuela): el precio es el costo final,
  // sin sumarle Shoppre/seguro/marítimo — esos ya están incluidos en su cotización.
  // No depende del modo: esa pieza nunca viaja en nuestra caja, venga por aire o por mar.
  if (product.priceIsLanded && product.priceUsd != null) {
    const landedCostUsd = product.priceUsd
    const { priceUsd, priceBsd } = applyMargin(landedCostUsd, product.margin, cfg)
    return {
      modo,
      productCostUsd: landedCostUsd,
      shoppreShippingUsd: 0,
      insuranceUsd: 0,
      maritimeUsd: 0,
      landedCostUsd,
      priceUsd,
      priceBsd,
      volumeM3: null,
      cbmFillPct: null,
    }
  }

  const esCbm      = modo === 'maritimo_cbm'
  const esMaritimo = modo === 'maritimo' || esCbm
  const hasDims = !!(product.dimL && product.dimA && product.dimH)

  // Cada modo exige el dato que efectivamente se factura: el aéreo cobra peso, el mar cobra
  // volumen. Sin dimensiones el flete marítimo sería 0 y el landed saldría falsamente barato
  // — peor que no mostrar nada, porque haría ver el mar como una ganga que no es.
  if (esMaritimo ? !hasDims : !product.weightGrams) return null

  const inrUsd         = parseFloat(cfg.inr_usd_rate          ?? '95')
  const productCostUsd = product.priceUsd != null ? product.priceUsd : product.priceInr! / inrUsd

  // ── Modo CBM ──────────────────────────────────────────────────────────────
  // El FOB es fijo por embarque y la naviera cobra un mínimo de m³, así que el costo
  // NO es aditivo por pieza: una pieza suelta no tiene landed propio hasta saber en qué
  // embarque viaja. Se resuelve igual que el aéreo con reference_weight_kg — prorrateando
  // sobre un EMBARQUE DE REFERENCIA (cbm_referencia_m3, por defecto el mínimo de 1 m³).
  // Una pieza que ocupa el 8.4% de ese embarque paga el 8.4% de (flete + FOB).
  if (esCbm) {
    const p          = cbmParams(cfg)
    const volumeM3   = (product.dimL! * product.dimA! * product.dimH!) / CM3_PER_M3
    const maritimeUsd = volumeM3 * cbmCostPerM3(p)

    // La tarifa plana ya incluye seguro, origen, destino y aduana: no se suma nada encima.
    const landedCostUsd = productCostUsd + maritimeUsd
    const { priceUsd, priceBsd } = applyMargin(landedCostUsd, product.margin, cfg)

    return {
      modo,
      productCostUsd,
      shoppreShippingUsd: 0,
      insuranceUsd: 0,
      maritimeUsd,
      landedCostUsd,
      priceUsd,
      priceBsd,
      volumeM3,
      cbmFillPct: volumeM3 / p.refM3,
    }
  }

  // Tramo aéreo India → USA, prorrateado sobre una caja de referencia. Por mar no existe.
  let shoppreShippingUsd = 0
  if (!esMaritimo) {
    const isMember    = cfg.shoppre_member                 !== 'false'
    const carrier     = cfg.shoppre_carrier                ?? 'ShipGlobal USA - Duty Free'
    const refWeightKg = num(cfg, 'reference_weight_kg', 15)
    const fraction    = product.weightGrams! / (refWeightKg * 1000)
    // Shoppre cotiza el flete en USD: la tarifa entra tal cual, sin pasar por inr_usd_rate.
    const refRateUsd  = getShoppReRateUsd(refWeightKg, carrier, isMember, cfg)
    shoppreShippingUsd = refRateUsd * fraction
  }

  const insurancePct = esMaritimo
    ? num(cfg, 'maritimo_insurance_pct', 0.06)
    : num(cfg, 'shoppre_insurance_pct', 0.03)
  const insuranceUsd = productCostUsd * insurancePct

  // Flete por volumen. En aéreo es el tramo corto Miami→CCS; en marítimo directo es el
  // flete completo India→Venezuela, que reemplaza también al aéreo.
  const maritimeMiami = num(cfg, 'miami_caracas_per_ft3', 45)
  const perFt3 = esMaritimo ? num(cfg, 'maritimo_directo_per_ft3', maritimeMiami) : maritimeMiami
  const maritimeUsd = hasDims
    ? ((product.dimL! * product.dimA! * product.dimH!) / CM3_PER_FT3) * perFt3
    : 0

  // Los cargos fijos por ENVÍO no entran al costo landed por pieza: el processing de Shoppre
  // en aéreo, y el mínimo facturable (maritimo_min_ft3) más los gastos de origen/destino
  // (maritimo_fee_usd) en marítimo. Todos se aplican una sola vez, en calcEnvio.
  const landedCostUsd = productCostUsd + shoppreShippingUsd + insuranceUsd + maritimeUsd
  const { priceUsd, priceBsd } = applyMargin(landedCostUsd, product.margin, cfg)

  return {
    modo,
    productCostUsd,
    shoppreShippingUsd,
    insuranceUsd,
    maritimeUsd,
    landedCostUsd,
    priceUsd,
    priceBsd,
    // El volumen se informa siempre que haya dimensiones (sirve para comparar contra el
    // escenario CBM), pero el % de llenado solo tiene sentido cuando el m³ es la unidad
    // que se factura.
    volumeM3: hasDims ? (product.dimL! * product.dimA! * product.dimH!) / CM3_PER_M3 : null,
    cbmFillPct: null,
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

// Modo de traída de la caja. Son cadenas logísticas distintas, no variantes de una:
//
//   aereo    (hoy):   India → USA por avión (Shoppre/ShipGlobal) → Venezuela por mar.
//   maritimo (escenario): India → Venezuela por mar, directo, cotizado por pie cúbico.
//                      Existe solo como comparación en el simulador; se conserva tal cual.
//   maritimo_cbm (real): India → Venezuela por mar, directo, con la cotización real:
//                      una TARIFA PLANA POR m³ que incluye todo el trayecto, más el FOB
//                      de India, que es un MONTO FIJO POR EMBARQUE. La naviera factura un
//                      mínimo de m³ (LCL) aunque la caja vaya a medio llenar.
//
// El peso deja de importar por completo en los modos marítimos: la naviera cobra volumen.
// Por eso el max(W,V) y el punto dulce de la tabla escalón no aplican ahí.
export type ModoEnvio = 'aereo' | 'maritimo' | 'maritimo_cbm'

// cm³ → m³. El catálogo guarda dimensiones en centímetros; la naviera cotiza en metros
// cúbicos, así que esta es la única conversión que hace falta en el modo CBM.
const CM3_PER_M3 = 1_000_000

// Parámetros del modo CBM, leídos de Config con defaults que no rompen nada si faltan.
export interface CbmParams {
  ratePerM3: number   // tarifa plana India → Venezuela, todo incluido
  fobUsd: number      // FOB en India: fijo por embarque, NO escala con el volumen
  minM3: number       // mínimo facturable de la naviera (LCL, típico 1 m³)
  refM3: number       // embarque de referencia para prorratear el FOB en el catálogo
}

// `fobOverride` es el FOB del proveedor al que se le compra el embarque. Cada proveedor
// cobra el suyo, así que el valor de Config es solo el respaldo para cuando no hay
// proveedor elegido (o no tiene FOB propio cargado).
export function cbmParams(cfg: ConfigMap, fobOverride?: number | null): CbmParams {
  const minM3 = num(cfg, 'cbm_min_m3', 1)
  // El embarque de referencia nunca puede ser menor que el mínimo facturable: si lo fuera,
  // el catálogo prorratearía sobre un volumen que la naviera jamás llegaría a cobrar.
  const refM3 = Math.max(num(cfg, 'cbm_referencia_m3', 1), minM3, 0.01)
  return {
    ratePerM3: num(cfg, 'cbm_rate_usd', 0),
    fobUsd:    fobOverride != null && Number.isFinite(fobOverride)
      ? fobOverride
      : num(cfg, 'cbm_fob_india_usd', 0),
    minM3,
    refM3,
  }
}

// Costo por m³ de un embarque de referencia lleno a `refM3`. El flete escala con el
// volumen pero el FOB no, así que el costo por m³ BAJA a medida que se llena la caja:
// es exactamente la razón por la que conviene consolidar antes de embarcar.
export function cbmCostPerM3(p: CbmParams): number {
  return (Math.max(p.refM3, p.minM3) * p.ratePerM3 + p.fobUsd) / p.refM3
}

export interface EnvioItemLine {
  pedidoId: number
  productId: number
  name: string
  quantity: number
  origen: 'india' | 'china'
  isLanded: boolean
  realKg: number          // peso real total de la línea (kg)
  volKg: number           // peso volumétrico total de la línea (kg) — solo aplica en aéreo
  ft3: number             // volumen real total de la línea (ft³) — la unidad que cobra el mar
  volumeM3: number        // el mismo volumen en m³ — la unidad que cotiza la naviera en CBM
  productCostUsd: number
  airUsd: number          // costo de llegar a USA (ShipGlobal si India, inbound si China). 0 en marítimo
  maritimeUsd: number     // su parte del flete marítimo
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
  modo: ModoEnvio
  // Tramos a USA, medidos por separado porque cotizan distinto. En modo marítimo los dos
  // cuestan 0 (la caja no pasa por USA) pero se siguen midiendo en kg, para poder comparar
  // contra el escenario aéreo sin recalcular.
  air: LegBreakdown                     // India → USA (ShipGlobal, tabla escalón en USD)
  china: LegBreakdown                   // China → USA (costo real cargado a mano)
  // Totales de la caja que cruza a Venezuela (India + China; los isLanded no viajan).
  // Van EMPAQUETADOS: es lo que va a leer la balanza y la cinta métrica del transportista,
  // que es lo único que se factura.
  realKg: number
  volKg: number
  chargeableKg: number
  // Volumen físico de la caja. El volumétrico (volKg) es una tarifa aérea; esto es el
  // espacio que ocupa de verdad, que es lo que cobra el marítimo y lo que hay que
  // guardar en el depósito.
  ft3: number
  // Los mismos totales SIN empaque: la suma de las piezas como están en el catálogo.
  // Se informan aparte porque son los que hay que comparar contra la caja real para
  // medir el factor, y porque son el único de los dos que el catálogo puede conocer.
  netRealKg: number
  netVolKg: number
  netFt3: number
  netVolumeM3: number
  // De dónde salieron los totales de arriba. `medido: false` ⇒ son la suma de las piezas,
  // o sea un piso, no un costo.
  caja: CajaFacturable
  binding: 'weight' | 'volume'
  ratioVW: number | null
  airUsd: number          // total a USA por los dos orígenes
  airPerKgUsd: number
  maritimeUsd: number
  // Volumen del flete marítimo. `billableFt3` es lo que efectivamente se factura: en
  // marítimo puede ser mayor que el real si la naviera cobra un mínimo por embarque.
  volumeFt3: number
  billableFt3: number
  maritimePerFt3: number
  minFt3Applied: boolean
  // ── Modo CBM ───────────────────────────────────────────────────────────────
  // Mismo volumen expresado en la unidad que factura la naviera, con su mínimo LCL.
  // `cbmFillPct` es el llenado del embarque (volumen real / facturable): por debajo de
  // 1.0 estás pagando aire, y es la señal de que conviene esperar a consolidar más.
  volumeM3: number
  billableM3: number
  cbmRatePerM3: number
  minM3Applied: boolean
  cbmFillPct: number
  // FOB de India: monto fijo por embarque. Se informa aparte del flete porque es el
  // cargo que se diluye al llenar (el flete por m³ no).
  fobUsd: number
  productCostUsd: number
  insuranceUsd: number
  // Cargo fijo por embarque: processing de Shoppre en aéreo, gastos de origen/destino
  // (handling, THC, aduana) en marítimo. Es el mismo lugar del costeo en los dos modos.
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
  // Irrelevante en modo marítimo: no hay tramo a USA.
  inboundChinaUsd?: number | null
  // Cadena logística a costear. Default 'aereo' — el modo en producción hoy.
  modo?: ModoEnvio
  // La caja como la pesó y midió el transportista. Ver `cajaFacturable`.
  medidas?: MedidasCaja | null
}

// ─────────────────────────────────────────────────────────────────────────────
// La caja como la pesó y midió el transportista.
//
// El catálogo guarda cada pieza CON SU EMPAQUE (ver MEASURES_PROMPT), así que sumar las
// piezas ya da algo parecido a la caja. Lo que la suma no puede saber es el cartón
// exterior y el hueco de acomodar piezas irregulares adentro, y eso se factura igual.
//
// Por eso, cuando la caja se pesó y se midió de verdad, esos números REEMPLAZAN a la
// suma — no la corrigen ni la multiplican. Lo que va a cobrar el transportista es lo que
// leyó de su balanza, no una cuenta nuestra.
// ─────────────────────────────────────────────────────────────────────────────
export interface MedidasCaja {
  // Peso que marcó la balanza del transportista, en kg (Shoppre lo llama "Actual Weight").
  pesoKg?: number | null
  // Dimensiones exteriores del cartón, en cm.
  dimL?: number | null
  dimA?: number | null
  dimH?: number | null
}

// De dónde salieron los totales de la caja que se costeó.
export interface CajaFacturable {
  // true = al menos uno de los dos totales lo dio una balanza o una cinta métrica.
  // false = son la suma de las piezas, que es un PISO: no incluye el cartón ni el hueco.
  medido: boolean
  pesoKg: number | null   // lo que se cargó, si se cargó
  cm3: number | null      // volumen del cartón, si se cargó
}

function cajaFacturable(medidas?: MedidasCaja | null): CajaFacturable {
  const pesoKg = medidas?.pesoKg != null && medidas.pesoKg > 0 ? medidas.pesoKg : null
  const cm3 = medidas?.dimL && medidas.dimA && medidas.dimH
    ? medidas.dimL * medidas.dimA * medidas.dimH
    : null
  return { medido: pesoKg != null || cm3 != null, pesoKg, cm3 }
}

// Mide un grupo de líneas como caja independiente: peso real, volumétrico, cuál de los
// dos ata, y reparte `costUsd` entre las líneas según la dimensión que ata. Así una
// pieza voluminosa y liviana viaja casi gratis cuando el grupo está atado por peso.
//
// `escala` reparte una caja PESADA entre los tramos: si la balanza dijo 18,6 kg y este
// grupo puso el 40% de las piezas, le tocan 7,4 kg. Con la caja sin pesar vale 1 y los kg
// del grupo son la suma de sus piezas, que es un piso. El reparto del costo entre líneas
// se hace sobre los netos, que están en la misma proporción.
function repartirTramo(
  lines: EnvioItemLine[],
  costUsd: number,
  escala: { peso: number; volumen: number },
): LegBreakdown {
  const realKg = lines.reduce((s, l) => s + l.realKg, 0) * escala.peso
  const volKg = lines.reduce((s, l) => s + l.volKg, 0) * escala.volumen
  const chargeableKg = Math.max(realKg, volKg)
  const binding: 'weight' | 'volume' = realKg >= volKg ? 'weight' : 'volume'

  const denom = lines.reduce((s, l) => s + (binding === 'weight' ? l.realKg : l.volKg), 0)
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
  const modo          = opts.modo ?? 'aereo'
  const esCbm         = modo === 'maritimo_cbm'
  const esMaritimo    = modo === 'maritimo' || esCbm
  const inrUsd        = parseFloat(cfg.inr_usd_rate           ?? '95')
  const isMember      = cfg.shoppre_member                    !== 'false'
  const carrier       = cfg.shoppre_carrier                   ?? 'ShipGlobal USA - Duty Free'
  const divisor       = parseFloat(cfg.air_volumetric_divisor ?? '5000')

  // Tarifa del flete por mar. En aéreo es el tramo corto Miami→CCS; en marítimo directo es
  // el flete completo India→Venezuela, que es otro número (más alto por ft³, pero reemplaza
  // al aéreo entero). Mientras no haya cotización cargada cae a la tarifa Miami→CCS para
  // que el simulador sea usable — la UI avisa que está usando el respaldo.
  const maritimeMiami = num(cfg, 'miami_caracas_per_ft3', 45)
  const maritimePft3  = esMaritimo ? num(cfg, 'maritimo_directo_per_ft3', maritimeMiami) : maritimeMiami
  // Mínimo facturable del embarque LCL. 0 = la naviera cobra el volumen real tal cual.
  const minFt3        = modo === 'maritimo' ? num(cfg, 'maritimo_min_ft3', 0) : 0
  // Parámetros de la cotización real por m³ (solo modo CBM).
  const cbm           = cbmParams(cfg)
  // Seguro sobre el costo de producto. El escenario marítimo en ft³ va al 6% (la carga por
  // mar viaja meses y la prima es más cara que la del aéreo, que está en 3%). En CBM el
  // seguro NO se suma aparte: la tarifa plana ya lo incluye todo.
  const insurancePct  = esCbm
    ? 0
    : modo === 'maritimo'
      ? num(cfg, 'maritimo_insurance_pct', 0.06)
      : num(cfg, 'shoppre_insurance_pct', 0.03)
  const processingInr = num(cfg, 'shoppre_processing_inr', 500)

  // Primera pasada: peso real, volumétrico, volumen en ft³ y costo de producto por línea.
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
      volumeM3: viaja && hasDims ? (cm3 / CM3_PER_M3) * qty : 0,
      productCostUsd: (it.priceUsd != null ? it.priceUsd : (it.priceInr ?? 0) / inrUsd) * qty,
      airUsd: 0,
      // El marítimo se reparte en una segunda pasada: con mínimo facturable deja de ser
      // aditivo por pieza (la caja paga un piso aunque nadie lo llene).
      maritimeUsd: 0,
      landedUsd: 0,
      // Un ítem que no viaja no "le falta" peso ni dimensiones: no se le piden.
      missingWeight: viaja && it.weightGrams == null,
      missingDims: viaja && !hasDims,
    }
  })

  const enBarco = lines.filter(l => !l.isLanded)
  const indiaLines = enBarco.filter(l => l.origen === 'india')
  const chinaLines = enBarco.filter(l => l.origen === 'china')

  // Netos: la suma de las piezas como están en el catálogo, sin un gramo de empaque.
  const netRealKg = enBarco.reduce((s, l) => s + l.realKg, 0)
  const netVolKg  = enBarco.reduce((s, l) => s + l.volKg, 0)
  const netFt3    = enBarco.reduce((s, l) => s + l.ft3, 0)
  const netM3     = enBarco.reduce((s, l) => s + l.volumeM3, 0)

  // La caja que se va a facturar. Si se pesó y se midió, mandan esos números: es lo que
  // leyó la balanza del transportista, no una cuenta nuestra. Si no, la suma de las
  // piezas — que es un piso, porque le falta el cartón y el hueco entre piezas.
  const caja = cajaFacturable(opts.medidas)
  const cajaKg  = caja.pesoKg ?? netRealKg
  const cajaCm3 = caja.cm3 ?? netM3 * CM3_PER_M3
  // Cómo repartir esa caja entre los tramos (India / China): cada uno se lleva la parte
  // proporcional a las piezas que puso. Con un solo origen —el caso normal— es exacto.
  const escala = {
    peso: netRealKg > 0 ? cajaKg / netRealKg : 1,
    volumen: netM3 > 0 ? cajaCm3 / (netM3 * CM3_PER_M3) : 1,
  }

  // Tramo India→USA: tarifa escalón de ShipGlobal sobre el peso cobrable de ESE grupo.
  // En marítimo directo la caja nunca pasa por USA, así que el tramo vale 0 — pero se sigue
  // midiendo en kg para poder comparar los dos escenarios lado a lado.
  const indiaChargeable = Math.max(
    indiaLines.reduce((s, l) => s + l.realKg, 0) * escala.peso,
    indiaLines.reduce((s, l) => s + l.volKg, 0) * escala.volumen,
  )
  const airRateUsd = !esMaritimo && indiaChargeable > 0
    ? getShoppReRateUsd(indiaChargeable, carrier, isMember, cfg)
    : 0
  const airLeg = repartirTramo(indiaLines, airRateUsd, escala)

  // Tramo China→USA: no hay tabla, es el costo real facturado.
  const chinaLeg = repartirTramo(chinaLines, esMaritimo ? 0 : (opts.inboundChinaUsd ?? 0), escala)

  // Totales de la caja marítima: los dos orígenes viajan juntos de USA a Venezuela.
  const W = cajaKg
  const V = netVolKg * escala.volumen
  const chargeableKg = Math.max(W, V)
  const binding: 'weight' | 'volume' = W >= V ? 'weight' : 'volume'
  const airUsd = airLeg.costUsd + chinaLeg.costUsd

  const landedDirectUsd = lines.filter(l => l.isLanded).reduce((s, l) => s + l.productCostUsd, 0)
  const productCostUsd  = lines.reduce((s, l) => s + l.productCostUsd, 0)

  // ── Flete marítimo ────────────────────────────────────────────────────────
  // Se factura el volumen de la caja, con un piso si la naviera cobra mínimo por embarque.
  // El piso hace que el costo NO sea aditivo por pieza, así que se reparte proporcional al
  // volumen de cada línea: si el mínimo infla la factura, todas las piezas lo absorben.
  // Si no viaja nada (todo el pedido es de proveedor landed) no hay embarque, y por lo
  // tanto tampoco mínimo que pagar: la caja no existe.
  // El flete marítimo se cobra sobre el volumen de la CAJA: el hueco que queda entre
  // piezas irregulares también viaja y también se paga.
  const volumeFt3     = cajaCm3 / CM3_PER_FT3
  const volumeM3      = cajaCm3 / CM3_PER_M3
  const billableFt3   = enBarco.length > 0 ? Math.max(volumeFt3, minFt3) : 0
  const minFt3Applied = enBarco.length > 0 && minFt3 > 0 && volumeFt3 < minFt3

  // Volumen facturable en CBM: la naviera cobra un piso por embarque (LCL), así que una
  // caja a medio llenar paga aire. Si no viaja nada, no hay embarque ni mínimo que pagar.
  const billableM3   = enBarco.length > 0 ? Math.max(volumeM3, cbm.minM3) : 0
  const minM3Applied = enBarco.length > 0 && cbm.minM3 > 0 && volumeM3 < cbm.minM3

  // En CBM el flete es la tarifa plana sobre el volumen facturable; el FOB va aparte
  // (es fijo por embarque y se suma como cargo del envío, más abajo).
  const maritimeUsd = esCbm ? billableM3 * cbm.ratePerM3 : billableFt3 * maritimePft3

  // Reparto: por volumen si hay dimensiones; si no hay ninguna cargada (pero igual se paga
  // el mínimo) se cae al costo de producto para no dejar el flete sin imputar a nadie.
  // Denominador en NETO: el empaque infla a todas las líneas por igual, así que la
  // proporción de cada una es la misma con factor o sin él.
  const volDenom  = esCbm ? netM3 : netFt3
  const costDenom = enBarco.reduce((s, l) => s + l.productCostUsd, 0)
  for (const l of enBarco) {
    const vol = esCbm ? l.volumeM3 : l.ft3
    if (volDenom > 0)       l.maritimeUsd = maritimeUsd * (vol / volDenom)
    else if (costDenom > 0) l.maritimeUsd = maritimeUsd * (l.productCostUsd / costDenom)
    else                    l.maritimeUsd = enBarco.length ? maritimeUsd / enBarco.length : 0
  }

  // Seguro y cargo fijo solo sobre lo que efectivamente viaja: el costo de los ítems
  // landed ya trae todos sus cargos incluidos en la cotización del proveedor.
  const insuranceUsd = (productCostUsd - landedDirectUsd) * insurancePct
  // Cargo fijo por embarque. En aéreo es el processing de Shoppre (solo si sale algo de
  // India); en el escenario en ft³ son los gastos de origen/destino; en CBM es el FOB de
  // India. Los tres se pagan una sola vez por caja y se reparten entre lo que viaja.
  const fobUsd = esCbm && enBarco.length > 0 ? cbm.fobUsd : 0
  const processingUsd = esCbm
    ? fobUsd
    : modo === 'maritimo'
      ? (enBarco.length > 0 ? num(cfg, 'maritimo_fee_usd', 0) : 0)
      : (indiaLines.length > 0 ? processingInr / inrUsd : 0)

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
    modo,
    air: airLeg,
    china: chinaLeg,
    realKg: W,
    volKg: V,
    chargeableKg,
    ft3: volumeFt3,
    netRealKg,
    netVolKg,
    netFt3,
    netVolumeM3: netM3,
    caja,
    binding,
    ratioVW: W > 0 ? V / W : null,
    airUsd,
    airPerKgUsd: chargeableKg > 0 ? airUsd / chargeableKg : 0,
    maritimeUsd,
    volumeFt3,
    billableFt3,
    maritimePerFt3: maritimePft3,
    minFt3Applied,
    volumeM3,
    billableM3,
    cbmRatePerM3: cbm.ratePerM3,
    minM3Applied,
    // Llenado del embarque: 1.0 = va lleno hasta el volumen que igual vas a pagar.
    cbmFillPct: billableM3 > 0 ? volumeM3 / billableM3 : 0,
    fobUsd,
    productCostUsd,
    insuranceUsd,
    processingUsd,
    landedUsd,
    landedDirectUsd,
    lines,
  }
}
