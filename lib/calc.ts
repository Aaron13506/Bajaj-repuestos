import { cotizarTramoAereo } from './shipping-rates'
import { inboundDe, type Inbound } from './inbound'
import { num, margenPorDefecto, type ConfigMap } from './config'

// El tipo se re-exporta porque medio repo lo importa desde acá y no hay razón para
// mover veinte imports; la definición vive en lib/config.ts junto a los lectores.
export type { ConfigMap }

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
  const bsdUsd = num(cfg, 'bsd_usd_rate', 715)
  // Margen efectivo: el de la pieza si lo tiene, si no el global de Config.
  //
  // Leía `cfg.default_margin`, key que no existe en ningún lado: la app entera —el seed,
  // /config, measures, el importador, los scripts— usa `default_margin_pct`, en PORCENTAJE.
  // Así que este fallback nunca se activó y toda pieza sin margen propio salía sin precio,
  // que parecía un dato faltante en vez de un bug. Y renombrar la key a secas no alcanzaba:
  // habría leído 40, y 40 ≥ 1 corta igual dos líneas más abajo. Falta el /100, que es lo
  // que hace margenPorDefecto().
  const effectiveMargin = margin ?? margenPorDefecto(cfg)

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

  const inrUsd         = num(cfg, 'inr_usd_rate', 95)
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
    // Por la misma cotización que el envío real: si la caja de referencia se configurara
    // por encima del tope del transportista, son dos cajas y no un escalón saturado.
    const refRateUsd  = cotizarTramoAereo(refWeightKg, carrier, isMember, cfg).costUsd
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
  // País de donde sale. Hoy solo informa (India / China): quien decide cómo se cobra el
  // tramo a USA es `inbound`, no el país.
  origen?: 'india' | 'china'
  // Por dónde entra a USA. 'shoppre' paga la tabla escalón de ShipGlobal sobre el peso
  // cobrable del grupo; 'cotizado' paga el monto plano que facturó el proveedor
  // (Envio.tramoUsd, prorrateado entre SUS piezas). Los dos cruzan el marítimo igual.
  inbound?: Inbound
  // A quién se le compró. Es la clave con la que se agrupan los tramos cotizados y los
  // giros: cada proveedor factura su tramo por separado y se le gira por separado.
  supplierId?: number | null
  // Proveedor que cotizó puesto en Venezuela: la pieza no viaja en esta caja. Queda
  // fuera del peso, del volumen y de todos los cargos de flete — su priceUsd YA es el
  // landed. La comisión del giro sí le toca: se le paga igual por transferencia.
  isLanded?: boolean
}

// Modo de traída de la caja. Son cadenas logísticas distintas, no variantes de una:
//
//   aereo    (hoy):   origen → USA por aire → Venezuela por mar. El tramo a USA lo cobra
//                      la tabla de ShipGlobal, o el total que pasó el proveedor.
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
//
// Se EXPORTA, igual que CM3_PER_FT3: estaba declarada dos veces (acá y en lib/cbm.ts) y
// re-derivada suelta como `/ 1_000_000` en nueve lugares más. Es la unidad que factura
// todo el carril marítimo — no debería tener diez definiciones.
export const CM3_PER_M3 = 1_000_000

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
  inbound: Inbound
  supplierId: number | null
  isLanded: boolean
  realKg: number          // peso real total de la línea (kg)
  volKg: number           // peso volumétrico total de la línea (kg) — solo aplica en aéreo
  ft3: number             // volumen real total de la línea (ft³) — la unidad que cobra el mar
  volumeM3: number        // el mismo volumen en m³ — la unidad que cotiza la naviera en CBM
  productCostUsd: number
  airUsd: number          // costo de llegar a USA (tabla de ShipGlobal, o el total cotizado). 0 en marítimo
  maritimeUsd: number     // su parte del flete marítimo
  comisionUsd: number     // su parte de la comisión del giro con el que se pagó su proveedor
  landedUsd: number       // costo landed total de la línea
  missingWeight: boolean
  missingDims: boolean
}

// Métricas de UN tramo hacia USA — el grupo que pasa por Shoppre, o el de cada proveedor
// que despacha por su cuenta. Se miden por separado porque el que cobra mira solo SU
// grupo: max(ΣpesoReal, Σvolumétrico) de esas piezas, no de la caja entera.
export interface LegBreakdown {
  items: number
  realKg: number
  volKg: number
  chargeableKg: number
  binding: 'weight' | 'volume'
  ratioVW: number | null  // V / W (utilización volumétrica)
  costUsd: number
  costPerKgUsd: number
  /**
   * En cuántas cajas viaja el tramo. El transportista tiene un tope por caja (hoy 22 kg),
   * así que pasado ese peso no hay "una caja más cara": hay dos cajas. Se expone porque
   * cambia lo que se está mirando —el $/kg de dos cajas no se compara con el de una— y
   * porque es el aviso de que el envío hay que dividirlo de verdad, no solo costearlo.
   * 0 cuando no viaja nada por este tramo; 1 en el caso normal.
   */
  cajas: number
  /** El peso facturable de cada caja, de mayor a menor. Vacío si no aplica. */
  cajasKg: number[]
  /** El tope por caja de la tarifa. null cuando el tramo no sale de una tabla. */
  capKg: number | null
}

// El tramo hasta USA cuando no hay tarifa: el proveedor despacha por su cuenta y pasa un
// total. No hay nada que calcular — lo único que hace el modelo es repartirlo entre las
// piezas de la caja por la dimensión que las ata, igual que el de ShipGlobal.
export interface TramoCotizado {
  nombre: string
  leg: LegBreakdown
  costUsd: number
  /** El proveedor todavía no pasó (o no se cargó) su total: el tramo cuenta 0 y la caja queda subcosteada. */
  faltaCosto: boolean
}

// El giro con el que se le paga al proveedor de la caja. Se arma aunque no haya comisión
// cargada: `montoUsd` es información por sí solo — es la base sobre la que el banco va a
// cobrar y lo que hay que mirar antes de anotar cuánto costó.
//
// ── Por qué son DOS comisiones y no una ─────────────────────────────────────────────
// Un giro internacional se cobra en las dos puntas y son dos números distintos, que
// llegan en momentos distintos y de fuentes distintas:
//
//   SALIENTE  lo que mi banco me descuenta por emitir la transferencia. Lo veo en mi
//             estado de cuenta el mismo día.
//   ENTRANTE  lo que el banco corresponsal y el del proveedor le descuentan al acreditar.
//             No aparece en mi cuenta: aparece en que él dice que recibió menos que lo
//             facturado, y entonces hay que completarle la diferencia. Es costo mío
//             igual, solo que me entero después y por WhatsApp.
//
// Guardarlas sumadas hacía imposible cargar la primera sin inventar la segunda, y como
// vacío ≠ cero, ese invento entraba al landed. Separadas, cada una se anota cuando se
// sabe y `cargada` dice si el giro terminó de costearse.
//
// Ninguna se calcula: son montos que se anotan (Envio.comisionSalienteUsd / EntranteUsd).
// No hay regla guardada en el proveedor a propósito — se le gira a algunos y no a otros, y
// el banco cobra distinto cada vez, así que un porcentaje guardado sería un número
// inventado con apariencia de dato. `cargada: false` es "todavía no la anoté", que no es
// lo mismo que $0.
export interface GiroProveedor {
  supplierId: number
  nombre: string
  /** Mercancía de la caja (incluye lo que llega puesto en Venezuela: se le paga igual). */
  mercanciaUsd: number
  /** Su tramo cotizado, si lo hay. Va en la misma factura, así que se gira junto. */
  tramoUsd: number
  /** Lo facturado: mercancía + tramo. Es la base sobre la que los dos bancos cobran. */
  montoUsd: number
  /** Lo que cobró MI banco por emitir el giro. 0 cuando no se cargó. */
  comisionSalienteUsd: number
  /** Lo que le descontaron a ÉL al acreditar y hubo que completarle. 0 cuando no se cargó. */
  comisionEntranteUsd: number
  /** Las dos juntas: es lo que entra al landed, porque las dos las pago yo. */
  comisionUsd: number
  salienteCargada: boolean
  entranteCargada: boolean
  /** Las dos anotadas: recién ahí el costo del giro está completo. */
  cargada: boolean
  /** Lo que este giro me costó de verdad, todo incluido. */
  costoTotalUsd: number
}

export interface EnvioBreakdown {
  modo: ModoEnvio
  // Tramos a USA, medidos por separado porque cotizan distinto. En modo marítimo todos
  // cuestan 0 (la caja no pasa por USA) pero se siguen midiendo en kg, para poder comparar
  // contra el escenario aéreo sin recalcular.
  air: LegBreakdown                     // lo que pasa por Shoppre (tabla escalón de ShipGlobal, en USD)
  tramo: TramoCotizado | null           // el total que facturó el proveedor, si despacha él
  // Totales de la caja que cruza a Venezuela (todos los tramos juntos; los isLanded no viajan).
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
  // Seguro de Shoppre. Solo sobre la mercancía que efectivamente pasa por su depósito: lo
  // que despacha el proveedor por su cuenta (DDP) nunca se le declara a Shoppre.
  insuranceUsd: number
  // Cargo fijo por embarque: processing de Shoppre en aéreo, gastos de origen/destino
  // (handling, THC, aduana) en marítimo. Es el mismo lugar del costeo en los dos modos.
  processingUsd: number
  // Las dos comisiones del giro con el que se pagó esta caja, sumadas. Ver GiroProveedor:
  // la saliente la cobra mi banco, la entrante se la descuentan a él y se la completo.
  comisionUsd: number
  // El giro al proveedor de la caja: cuánto se le manda y si la comisión ya se anotó.
  // null cuando la caja no tiene proveedor (99rpm, que se paga de otra forma).
  giro: GiroProveedor | null
  landedUsd: number
  // Ítems que no viajan en la caja (proveedor landed): su costo entra al total pero
  // no toca peso, volumen ni cargos de flete.
  landedDirectUsd: number
  lines: EnvioItemLine[]
}

// Lo que el costeo necesita saber del proveedor de la caja. Viene de afuera (Supplier +
// las dos columnas de Envio) porque lib/calc no toca la base.
export interface ProveedorEnvio {
  supplierId: number
  nombre: string
  /** Solo para 'cotizado': el total que facturó por llevar la caja a USA. null = no cargado. */
  tramoUsd?: number | null
  /** Lo que cobró mi banco por emitir el giro. null = todavía no se anotó (≠ 0). */
  comisionSalienteUsd?: number | null
  /** Lo que le descontaron al acreditar y hubo que completarle. null = no se anotó (≠ 0). */
  comisionEntranteUsd?: number | null
}

export interface EnvioOptions {
  // El proveedor de la caja, con los montos que nadie puede derivar: el total que facturó
  // por el tramo a USA (solo si despacha él) y las dos comisiones del giro con el que se le
  // pagó. Sin el tramo, las piezas viajan gratis en el cálculo — `tramo.faltaCosto` lo
  // marca para que la UI avise. Ausente = la caja es de 99rpm, por Shoppre.
  proveedor?: ProveedorEnvio | null
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
  cajas: { cajas: number; pesosKg: number[]; capKg: number | null } = { cajas: lines.length > 0 ? 1 : 0, pesosKg: [], capKg: null },
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
    cajas: cajas.cajas,
    cajasKg: cajas.pesosKg,
    capKg: cajas.capKg,
  }
}

export function calcEnvio(items: EnvioItemInput[], cfg: ConfigMap, opts: EnvioOptions = {}): EnvioBreakdown {
  const modo          = opts.modo ?? 'aereo'
  const esCbm         = modo === 'maritimo_cbm'
  const esMaritimo    = modo === 'maritimo' || esCbm
  const inrUsd        = num(cfg, 'inr_usd_rate', 95)
  const isMember      = cfg.shoppre_member                    !== 'false'
  const carrier       = cfg.shoppre_carrier                   ?? 'ShipGlobal USA - Duty Free'
  const divisor       = num(cfg, 'air_volumetric_divisor', 5000)

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
    const inbound = inboundDe(origen, it.inbound)
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
      inbound,
      supplierId: it.supplierId ?? null,
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
      // La comisión se reparte al final: depende del total girado a ese proveedor, que
      // incluye su tramo, y el tramo todavía no se repartió.
      comisionUsd: 0,
      landedUsd: 0,
      // Un ítem que no viaja no "le falta" peso ni dimensiones: no se le piden.
      missingWeight: viaja && it.weightGrams == null,
      missingDims: viaja && !hasDims,
    }
  })

  const enBarco = lines.filter(l => !l.isLanded)
  // El corte NO es por país: es por si el tramo tiene tarifa. Lo que pasa por el depósito
  // de Shoppre paga UNA tabla escalón sobre el peso del grupo (por eso juntar kilos ahí
  // abarata); lo que despacha el proveedor por su cuenta es su factura y no se mezcla.
  //
  // Una caja se compra a UN proveedor, así que en la práctica todo cae de un lado o del
  // otro. El corte se hace igual por línea y no por caja porque cada PedidoItem guarda su
  // propio snapshot: una caja vieja, armada antes de que el proveedor fuera de la caja,
  // puede tener las dos cosas adentro y tiene que seguir costeándose bien.
  const shoppreLines = enBarco.filter(l => l.inbound === 'shoppre')
  const cotizadoLines = enBarco.filter(l => l.inbound === 'cotizado')

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
  // Cómo repartir esa caja entre los tramos: cada uno se lleva la parte proporcional a las
  // piezas que puso. Con un solo tramo —el caso normal— es exacto.
  const escala = {
    peso: netRealKg > 0 ? cajaKg / netRealKg : 1,
    volumen: netM3 > 0 ? cajaCm3 / (netM3 * CM3_PER_M3) : 1,
  }

  // Tramo Shoppre→USA: tarifa escalón de ShipGlobal sobre el peso cobrable de ESE grupo.
  // En marítimo directo la caja nunca pasa por USA, así que el tramo vale 0 — pero se sigue
  // midiendo en kg para poder comparar los dos escenarios lado a lado.
  const shoppreChargeable = Math.max(
    shoppreLines.reduce((s, l) => s + l.realKg, 0) * escala.peso,
    shoppreLines.reduce((s, l) => s + l.volKg, 0) * escala.volumen,
  )
  // El transportista tiene un tope por caja: pasado ese peso no existe "una caja más
  // pesada", existen dos cajas. Saturar en el último escalón —lo que hacía el lookup
  // simple— cobraba 24 kg al precio de 22 y 44 kg también al de 22, y el error crece con
  // el peso justo en el sentido peligroso: el aéreo se abarata al juntar kilos, así que
  // subcostear el exceso premiaba amontonar en una caja que ya no se puede despachar.
  const airQuote = !esMaritimo && shoppreChargeable > 0
    ? cotizarTramoAereo(shoppreChargeable, carrier, isMember, cfg)
    : { costUsd: 0, cajas: 0, pesosKg: [] as number[], capKg: null as number | null }
  const airLeg = repartirTramo(shoppreLines, airQuote.costUsd, escala, airQuote)

  // Tramo cotizado: no hay tabla, es el total que facturó el proveedor de la caja.
  const prov = opts.proveedor ?? null
  const tramoCostUsd = esMaritimo ? 0 : (prov?.tramoUsd ?? 0)
  const tramo: TramoCotizado | null = cotizadoLines.length > 0
    ? {
        nombre: prov?.nombre ?? 'Proveedor sin identificar',
        leg: repartirTramo(cotizadoLines, tramoCostUsd, escala),
        costUsd: tramoCostUsd,
        faltaCosto: !esMaritimo && prov?.tramoUsd == null,
      }
    : null
  const cotizadoUsd = tramo?.costUsd ?? 0

  // Totales de la caja marítima: los dos orígenes viajan juntos de USA a Venezuela.
  const W = cajaKg
  const V = netVolKg * escala.volumen
  const chargeableKg = Math.max(W, V)
  const binding: 'weight' | 'volume' = W >= V ? 'weight' : 'volume'
  const airUsd = airLeg.costUsd + cotizadoUsd

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

  // Seguro y processing son cargos DE SHOPPRE, así que se cobran sobre lo que pasa por
  // Shoppre y nada más. Un proveedor que despacha DDP por su cuenta ya pagó los impuestos
  // de salida y no le declara nada a Shoppre: cargarle el 3% del seguro sería inventarle
  // un costo que nadie factura, y encima haría ver más caro justamente el camino que se
  // eligió por barato. Los ítems landed tampoco pagan: su cotización ya trae todo adentro.
  //
  // En los modos marítimos no hay Shoppre en el medio, así que el grupo es todo lo que
  // viaja (el seguro del escenario en ft³ es de la naviera, no de Shoppre).
  const baseSeguro = esMaritimo
    ? productCostUsd - landedDirectUsd
    : shoppreLines.reduce((acc, l) => acc + l.productCostUsd, 0)
  const insuranceUsd = baseSeguro * insurancePct
  // Cargo fijo por embarque. En aéreo es el processing de Shoppre (solo si hay algo que
  // pase por Shoppre); en el escenario en ft³ son los gastos de origen/destino; en CBM es
  // el FOB. Los tres se pagan una sola vez por caja y se reparten entre lo que viaja.
  const fobUsd = esCbm && enBarco.length > 0 ? cbm.fobUsd : 0
  const processingUsd = esCbm
    ? fobUsd
    : modo === 'maritimo'
      ? (enBarco.length > 0 ? num(cfg, 'maritimo_fee_usd', 0) : 0)
      : (shoppreLines.length > 0 ? processingInr / inrUsd : 0)

  // ── El giro al proveedor ──────────────────────────────────────────────────
  // Una caja, un proveedor, un giro: le llega una factura (mercancía + su tramo) y se le
  // transfiere una vez. Se arma aunque no haya comisión cargada, porque el monto girado es
  // información por sí solo — es la base sobre la que el banco va a cobrar.
  //
  // Los ítems landed entran al monto: no viajan en la caja, pero se le pagan al proveedor
  // por la misma vía y en el mismo giro.
  const mercanciaProveedor = lines.reduce((acc, l) => acc + l.productCostUsd, 0)
  // Cargada explícitamente en 0 es un dato ("ese lado del giro no costó nada") y se respeta;
  // ausente es "no lo anoté todavía" y la UI lo dice en vez de mostrar un cero falso. Cada
  // punta se anota por separado porque se conocen en momentos distintos: la saliente el
  // mismo día, la entrante cuando el proveedor avisa que le llegó de menos.
  const salienteCargada = prov?.comisionSalienteUsd != null
  const entranteCargada = prov?.comisionEntranteUsd != null
  const salienteUsd = salienteCargada ? prov!.comisionSalienteUsd! : 0
  const entranteUsd = entranteCargada ? prov!.comisionEntranteUsd! : 0
  const montoFacturado = mercanciaProveedor + cotizadoUsd
  const giro: GiroProveedor | null = prov
    ? {
        supplierId: prov.supplierId,
        nombre: prov.nombre,
        mercanciaUsd: mercanciaProveedor,
        tramoUsd: cotizadoUsd,
        montoUsd: montoFacturado,
        comisionSalienteUsd: salienteUsd,
        comisionEntranteUsd: entranteUsd,
        // Las dos las pago yo: la saliente me la descuenta mi banco, la entrante se la
        // descuentan a él y se la termino completando. Suman al landed por igual.
        comisionUsd: salienteUsd + entranteUsd,
        salienteCargada,
        entranteCargada,
        cargada: salienteCargada && entranteCargada,
        costoTotalUsd: montoFacturado + salienteUsd + entranteUsd,
      }
    : null
  const comisionUsd = giro?.comisionUsd ?? 0

  // Reparto de la comisión entre las líneas, proporcional al costo de producto: es lo que
  // hace que el landed por pieza siga siendo comparable contra su precio de venta. Entran
  // también las líneas landed, porque estuvieron en el mismo giro.
  if (comisionUsd !== 0 && lines.length > 0) {
    const denom = lines.reduce((acc, l) => acc + l.productCostUsd, 0)
    for (const l of lines) {
      l.comisionUsd = denom > 0
        ? comisionUsd * (l.productCostUsd / denom)
        : comisionUsd / lines.length
    }
  }

  const landedUsd = productCostUsd + airUsd + insuranceUsd + processingUsd + maritimeUsd + comisionUsd

  // Landed por línea: base directa (producto + tramo a USA + marítimo + su comisión) +
  // prorrateo de los cargos de Shoppre (seguro, processing).
  //
  // Ese prorrateo se hace SOLO entre las líneas que pasan por Shoppre, que son las únicas
  // que los generan. Repartirlos sobre toda la caja le cargaría a una pieza de Garuda una
  // parte del seguro de Shoppre, y entonces el landed por pieza dejaría de servir para lo
  // único que sirve: comparar dos proveedores del mismo SKU. En los modos marítimos no
  // hay Shoppre, así que el grupo vuelve a ser todo lo que viaja.
  const conOverhead = esMaritimo ? enBarco : shoppreLines
  const baseSum = conOverhead.reduce((s, l) => s + l.productCostUsd + l.airUsd + l.maritimeUsd, 0)
  const overhead = insuranceUsd + processingUsd
  // Set y no `conOverhead.includes(l)` adentro del for: aquello recorría el array entero
  // por cada línea (O(n²)) para responder una pertenencia. Con las líneas como objetos,
  // el Set compara por identidad igual que includes — mismo resultado, una pasada.
  const pagaOverhead = new Set(conOverhead)
  for (const l of lines) {
    if (l.isLanded) {
      // No viaja: su precio ya es el landed. Lo único que se le suma es la comisión del
      // giro, porque el giro sí existió.
      l.landedUsd = l.productCostUsd + l.comisionUsd
      continue
    }
    const base = l.productCostUsd + l.airUsd + l.maritimeUsd
    const suOverhead = pagaOverhead.has(l) && baseSum > 0 ? overhead * (base / baseSum) : 0
    l.landedUsd = base + l.comisionUsd + suOverhead
  }

  return {
    modo,
    air: airLeg,
    tramo,
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
    comisionUsd,
    giro,
    landedUsd,
    landedDirectUsd,
    lines,
  }
}
