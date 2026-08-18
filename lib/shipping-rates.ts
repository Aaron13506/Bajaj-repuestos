import baseline from '@/shipping_rates.json'

// Tabla escalón de Shoppre India→USA, en DÓLARES. La API de Shoppre ya devuelve el
// precio convertido (`customer_rate_in_usd`), así que el tramo aéreo no pasa por
// inr_usd_rate: antes se guardaba en rupias y se dividía por la tasa del día, lo que
// movía el costo de flete cada vez que se movía la rupia aunque Shoppre no hubiera
// tocado su tarifa.
//
// Se guarda como escalones [pesoTopeKg, precioUsd] y no fila por peso: la tarifa ES
// una función escalón (0.5→1.0 kg cuesta lo mismo), así que colapsar los tramos
// repetidos baja la tabla de ~400 filas a ~90 sin perder un solo precio. Importa
// porque esta tabla viaja en el payload de cada página que costea (ver
// `shoppre_rates_usd` en Config).
export type RateStep = [maxKg: number, basicUsd: number]

export interface RateTable {
  generated_at: string
  // El descuento de socio es un porcentaje fijo que Shoppre aplica en el cliente, no
  // un precio aparte: se deriva del básico en vez de duplicar la tabla.
  member_discount: number
  carriers: Record<string, RateStep[]>
}

// Forma del dataset que devuelve scripts/shoppre-scraper.js.
export interface ScrapedRates {
  member_discount: number
  generated_at: string
  rates: Array<{
    weight_kg: number
    carriers: Array<{ carrier: string; basic_price_usd: number }>
  }>
}

export const CARRIER_DUTY_FREE = 'ShipGlobal USA - Duty Free'
export const CARRIER_ECONOMY   = 'Economy Shipping'

/** Convierte una corrida del scraper en la tabla de escalones que consume la app. */
export function buildRateTable(scraped: ScrapedRates): RateTable {
  const carriers: Record<string, RateStep[]> = {}

  const rows = [...scraped.rates].sort((a, b) => a.weight_kg - b.weight_kg)
  for (const row of rows) {
    for (const c of row.carriers) {
      const steps = (carriers[c.carrier] ??= [])
      const last = steps[steps.length - 1]
      // Mismo precio que el peso anterior: es el mismo escalón, se estira su tope.
      if (last && last[1] === c.basic_price_usd) last[0] = row.weight_kg
      else steps.push([row.weight_kg, c.basic_price_usd])
    }
  }

  return {
    generated_at: scraped.generated_at,
    member_discount: scraped.member_discount,
    carriers,
  }
}

function isRateTable(value: unknown): value is RateTable {
  const t = value as RateTable
  return !!t && typeof t === 'object' && !!t.carriers && Object.keys(t.carriers).length > 0
}

const BASELINE = baseline as unknown as RateTable

// Parsear la tabla es barato pero calcLanded corre una vez por producto listado, así
// que se cachea por el string crudo: mientras el cron no la reescriba, es la misma.
let cached: { raw: string; table: RateTable } | null = null

/**
 * Tabla vigente: la que dejó el cron en Config (`shoppre_rates_usd`), y si no hay o
 * está corrupta, la que quedó congelada en shipping_rates.json al buildear. El
 * fallback existe para que un scrape fallido no deje la app sin costear.
 */
export function resolveRateTable(cfg?: Record<string, string>): RateTable {
  const raw = cfg?.shoppre_rates_usd
  if (!raw) return BASELINE
  if (cached?.raw === raw) return cached.table

  try {
    const parsed = JSON.parse(raw)
    if (!isRateTable(parsed)) return BASELINE
    cached = { raw, table: parsed }
    return parsed
  } catch {
    return BASELINE
  }
}

/** Precio USD del tramo India→USA para un peso cobrable. Escalón: gana el primer tope ≥ peso. */
export function getShoppReRateUsd(
  weightKg: number,
  carrier: string,
  isMember: boolean,
  cfg?: Record<string, string>,
): number {
  const table = resolveRateTable(cfg)
  const steps = table.carriers[carrier] ?? table.carriers[CARRIER_DUTY_FREE] ?? Object.values(table.carriers)[0]
  const step = steps.find(s => s[0] >= weightKg) ?? steps[steps.length - 1]
  const basic = step[1]
  return isMember ? Number((basic * (1 - table.member_discount)).toFixed(2)) : basic
}