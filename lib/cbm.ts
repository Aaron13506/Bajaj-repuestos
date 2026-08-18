import { cbmParams, type ConfigMap } from './calc'
import { expandCostPieces, type ProductCost, type ProductLookup } from './envio-build'
import type { BundlePiece } from './bundle'

// ─────────────────────────────────────────────────────────────────────────────
// Resumen CBM de un conjunto de líneas (un presupuesto, o todos los presupuestos que
// van a entrar en el próximo embarque).
//
// Es el cálculo del modo marítimo visto desde el DOCUMENTO, no desde la caja: mientras
// armás un presupuesto todavía no existe ningún envío, pero igual necesitás saber cuánto
// volumen estás comprometiendo y a qué costo. Por eso acá NO se aplica el mínimo
// facturable de la naviera (ese es un hecho del embarque, no de un presupuesto suelto):
// se cobra lo que ocupa, linealmente, más la parte del FOB que le toca.
//
//   flete   = m³ × tarifa            ($1000/m³ → 2 m³ = $2000, escala lineal)
//   FOB     = m³ / referencia × FOB  (el FOB es fijo por embarque; se prorratea sobre el
//                                     embarque de referencia para poder costear una parte)
//
// La suma de los dos da exactamente el mismo número que calcLanded en modo CBM
// (volumen × cbmCostPerM3): acá solo se muestran separados, porque son cargos de
// naturaleza distinta — uno escala al llenar y el otro se diluye.
// ─────────────────────────────────────────────────────────────────────────────

// Tope de densidad de la naviera: por encima de esto el m³ deja de ser la unidad que
// factura y pasan a cobrar por peso. Con repuestos de moto es difícil llegar, pero una
// caja de discos de freno o coronas puede pasarse.
export const CBM_MAX_KG_PER_M3 = 1000

const CM3_PER_M3 = 1_000_000

export interface CbmLineaInput {
  /** Id de la línea de origen (PedidoItem), para poder mapear el resultado de vuelta. */
  itemId: number
  pedidoId: number
  productId: number
  quantity: number
  salePrice: number
  bundleItems: BundlePiece[] | null
  product: ProductCost
}

export interface CbmPieza {
  itemId: number
  productId: number | null
  name: string
  sku: string | null
  quantity: number
  weightGrams: number | null
  volumeM3: number         // volumen total de la línea (× cantidad)
  weightKg: number
  costoOrigenUsd: number
  fleteUsd: number         // su parte del flete por m³
  fobUsd: number           // su parte del FOB prorrateado
  landedUsd: number
  /** Sin dimensiones no hay volumen, y sin volumen no hay costo por mar: la línea queda a medio costear. */
  sinMedidas: boolean
  sinPrecio: boolean
}

export interface CbmResumen {
  piezas: CbmPieza[]
  volumeM3: number
  weightKg: number
  /** kg/m³ del conjunto. null si todavía no hay volumen cargado. */
  densidad: number | null
  excedeDensidad: boolean
  /** Piezas a las que les falta peso o dimensiones — el volumen real es MAYOR que el que se ve. */
  sinMedidas: number
  sinPrecio: number
  costoOrigenUsd: number
  fleteUsd: number
  fobUsd: number
  landedUsd: number
  ventaUsd: number
  /** Margen sobre venta: (venta − landed) / venta. null si no hay venta cargada. */
  margenPct: number | null
  /** Qué fracción del embarque de referencia ocupa este conjunto. */
  fillPct: number
  ratePerM3: number
  refM3: number
  minM3: number
  fobTotalUsd: number
}

export interface CbmOpts {
  /** Precios USD del proveedor del embarque, por productId. Sin fila ⇒ se usa priceInr. */
  priceMap?: Map<number, { priceUsd: number; isLanded: boolean }>
  /** FOB del proveedor. Null ⇒ el default global de Config. */
  fobUsd?: number | null
}

/**
 * Costea un conjunto de líneas por volumen. Los conjuntos (bundleItems) se expanden a sus
 * piezas reales: un ensamble vendido como unidad ocupa el volumen de las piezas que
 * realmente lleva, no el del ensamble entero del catálogo.
 */
export function resumirCbm(
  lineas: CbmLineaInput[],
  lookup: ProductLookup,
  cfg: ConfigMap,
  opts: CbmOpts = {},
): CbmResumen {
  const p = cbmParams(cfg, opts.fobUsd)
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  const priceMap = opts.priceMap ?? new Map()

  const piezas: CbmPieza[] = []
  for (const linea of lineas) {
    for (const pieza of expandCostPieces(linea.product, linea.quantity, linea.bundleItems, lookup)) {
      const override = pieza.productId != null ? priceMap.get(pieza.productId) : undefined
      const hasDims = !!(pieza.dimL && pieza.dimA && pieza.dimH)
      const volumeM3 = hasDims ? ((pieza.dimL! * pieza.dimA! * pieza.dimH!) / CM3_PER_M3) * pieza.quantity : 0

      const unitCost = override?.priceUsd ?? (pieza.priceInr != null ? pieza.priceInr / inrUsd : null)
      const costoOrigenUsd = (unitCost ?? 0) * pieza.quantity

      // El proveedor que cotiza puesto en Venezuela no manda nada en el contenedor: no
      // ocupa volumen ni paga flete, su precio YA es el landed.
      const viaja = !(override?.isLanded ?? false)
      const fleteUsd = viaja ? volumeM3 * p.ratePerM3 : 0
      const fobUsd   = viaja ? (volumeM3 / p.refM3) * p.fobUsd : 0

      piezas.push({
        itemId: linea.itemId,
        productId: pieza.productId,
        name: pieza.name,
        sku: pieza.sku,
        quantity: pieza.quantity,
        weightGrams: pieza.weightGrams,
        volumeM3: viaja ? volumeM3 : 0,
        weightKg: viaja ? ((pieza.weightGrams ?? 0) / 1000) * pieza.quantity : 0,
        costoOrigenUsd,
        fleteUsd,
        fobUsd,
        landedUsd: costoOrigenUsd + fleteUsd + fobUsd,
        sinMedidas: viaja && !hasDims,
        sinPrecio: unitCost == null,
      })
    }
  }

  const sum = (f: (x: CbmPieza) => number) => piezas.reduce((s, x) => s + f(x), 0)
  const volumeM3 = sum(x => x.volumeM3)
  const weightKg = sum(x => x.weightKg)
  const landedUsd = sum(x => x.landedUsd)
  const ventaUsd = lineas.reduce((s, l) => s + l.salePrice * l.quantity, 0)
  const densidad = volumeM3 > 0 ? weightKg / volumeM3 : null

  return {
    piezas,
    volumeM3,
    weightKg,
    densidad,
    excedeDensidad: densidad != null && densidad > CBM_MAX_KG_PER_M3,
    sinMedidas: piezas.filter(x => x.sinMedidas).length,
    sinPrecio: piezas.filter(x => x.sinPrecio).length,
    costoOrigenUsd: sum(x => x.costoOrigenUsd),
    fleteUsd: sum(x => x.fleteUsd),
    fobUsd: sum(x => x.fobUsd),
    landedUsd,
    ventaUsd,
    margenPct: ventaUsd > 0 ? (ventaUsd - landedUsd) / ventaUsd : null,
    fillPct: p.refM3 > 0 ? volumeM3 / p.refM3 : 0,
    ratePerM3: p.ratePerM3,
    refM3: p.refM3,
    minM3: p.minM3,
    fobTotalUsd: p.fobUsd,
  }
}

/**
 * Precio de venta que sale de aplicar el margen sobre el landed CBM, por línea y total.
 *
 * Existe porque `PedidoItem.salePrice` es un SNAPSHOT del momento en que se cotizó: un
 * documento armado en modo aéreo lleva precios de la cadena aérea, y compararlos contra un
 * landed marítimo da un margen que no significa nada (dos modelos de costo distintos en la
 * misma resta). Todo lo que se mire en modo CBM tiene que recotizarse acá, desde cero.
 *
 * Para un pedido de CLIENTE el precio congelado sigue mandando — es un compromiso ya
 * conversado. Para stock propio no hay compromiso con nadie: el precio es una proyección y
 * se recalcula con la cadena por la que realmente va a entrar.
 */
export function sugerirVenta(
  resumen: CbmResumen,
  margenPorProducto: Map<number, number | null>,
  defaultMargin: number,
): { totalUsd: number | null; porItem: Map<number, number | null> } {
  const porItem = new Map<number, number | null>()
  let totalUsd: number | null = 0

  for (const p of resumen.piezas) {
    const margen = (p.productId != null ? margenPorProducto.get(p.productId) : null) ?? defaultMargin
    // Un margen >= 1 (o no numérico) haría explotar el precio: esa línea queda sin sugerencia
    // y arrastra al total, para no mostrar una venta que no cubre todo lo que hay adentro.
    const valido = Number.isFinite(margen) && margen < 1
    const precio = valido ? p.landedUsd / (1 - margen) : null

    const previo = porItem.get(p.itemId)
    porItem.set(
      p.itemId,
      precio == null || previo === null ? null : (previo ?? 0) + precio,
    )
    if (precio == null) totalUsd = null
    else if (totalUsd != null) totalUsd += precio
  }

  return { totalUsd, porItem }
}

/**
 * Costo REAL por m³ de un embarque de un volumen dado: el flete escala pero el FOB no,
 * así que llenar más barato sale. Es la curva que justifica esperar a consolidar.
 * Por debajo del mínimo facturable se paga igual el mínimo, y ahí el costo por m³ se
 * dispara — que es exactamente lo que hay que ver antes de mandar una caja a medio llenar.
 */
export function costoRealPorM3(volumeM3: number, cfg: ConfigMap, fobUsd?: number | null): number | null {
  const p = cbmParams(cfg, fobUsd)
  if (volumeM3 <= 0) return null
  const facturable = Math.max(volumeM3, p.minM3)
  return (facturable * p.ratePerM3 + p.fobUsd) / volumeM3
}

/** Costo total de un embarque de ese volumen (flete facturable + FOB fijo). */
export function costoEmbarque(volumeM3: number, cfg: ConfigMap, fobUsd?: number | null): { facturableM3: number; fleteUsd: number; fobUsd: number; totalUsd: number; pagaMinimo: boolean } {
  const p = cbmParams(cfg, fobUsd)
  const facturableM3 = Math.max(volumeM3, p.minM3)
  const fleteUsd = facturableM3 * p.ratePerM3
  return {
    facturableM3,
    fleteUsd,
    fobUsd: p.fobUsd,
    totalUsd: fleteUsd + p.fobUsd,
    pagaMinimo: volumeM3 < p.minM3,
  }
}