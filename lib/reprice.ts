import { calcLanded, type ConfigMap } from './calc'

// ─────────────────────────────────────────────────────────────────────────────
// Recálculo del precio de venta cuando cambia el COSTO de una pieza.
//
// Es la regla de plata del catálogo, y por eso vive en un solo lugar: la usan la carga de
// medidas (lib/measures.ts, cuando llega el peso y recién ahí se puede costear) y la
// actualización de precios de 99rpm (scripts/update-prices-99rpm.ts, cuando cambia el ₹).
// Los dos disparadores son distintos pero la cuenta es la misma, y tenerla dos veces sería
// tener dos catálogos que se contradicen.
//
// El precio de venta sale SIEMPRE de la cadena aérea: es por donde viajan los pedidos de
// cliente. El landed marítimo decide dónde abastecerse, no a cuánto vender.
//
// `priceLocked` invierte la dirección del cálculo. Sin candado, el precio se deriva del
// costo (precio = landed / (1 − margen)). Con candado, el precio es un dato dado y lo que
// se deriva es el margen (margen = 1 − landed / precio): sigue siendo la misma identidad,
// pero despejando la otra incógnita. Por eso un cambio de costo nunca mueve un precio
// fijado a mano — solo te muestra qué margen te quedó.
// ─────────────────────────────────────────────────────────────────────────────

export interface RepriceInput {
  priceInr: number | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
  /** Precio de venta actual. Solo se usa cuando está fijado a mano. */
  price: number
  priceLocked?: boolean
}

export interface RepriceResult {
  /** Campos a persistir. Vacío si no hay costo calculable todavía (falta peso). */
  data: { margin?: number; landedCostUsd?: number; price?: number }
  /** El costo landed que salió de la cuenta. null = no se pudo calcular. */
  landedCostUsd: number | null
  /** true si `data` trae un precio de venta nuevo. */
  repriced: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Qué actualizar en un producto cuyo costo cambió. Es pura: no toca la base, así que el
 * llamador puede mostrar el efecto antes de aplicarlo (los scripts corren en seco por
 * defecto). `defaultMargin` es el global de Config, para las piezas sin margen propio.
 */
export function reprice(p: RepriceInput, cfg: ConfigMap, defaultMargin: number): RepriceResult {
  // Margen efectivo: el de la pieza si lo tiene, si no el default global.
  const effMargin = p.margin ?? defaultMargin
  const breakdown = calcLanded({ ...p, margin: effMargin }, cfg, 'aereo')

  const data: RepriceResult['data'] = {}
  let repriced = false

  if (p.priceLocked) {
    if (breakdown) {
      data.landedCostUsd = round2(breakdown.landedCostUsd)
      const price = Number(p.price)
      if (price > 0) data.margin = +(1 - breakdown.landedCostUsd / price).toFixed(4)
    }
  } else {
    // Se persiste el margen efectivo aunque todavía no haya precio calculable, para que
    // quede visible con qué margen va a costearse cuando llegue el peso.
    if (Number.isFinite(effMargin)) data.margin = effMargin
    if (breakdown) {
      data.landedCostUsd = round2(breakdown.landedCostUsd)
      if (breakdown.priceUsd != null) {
        data.price = round2(breakdown.priceUsd)
        repriced = true
      }
    }
  }

  return { data, landedCostUsd: breakdown?.landedCostUsd ?? null, repriced }
}
