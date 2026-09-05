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

/**
 * El peso máximo que la tabla sabe cotizar: el tope del último escalón (hoy 22 kg en los
 * tres carriers). NO es un detalle del scraper — es el límite por caja del transportista,
 * y por eso mandar más que eso no es "un precio que falta", es OTRA caja.
 */
export function capacidadCajaKg(carrier: string, cfg?: Record<string, string>): number {
  const steps = pasosDe(carrier, cfg)
  return steps[steps.length - 1][0]
}

function pasosDe(carrier: string, cfg?: Record<string, string>): RateStep[] {
  const table = resolveRateTable(cfg)
  return table.carriers[carrier] ?? table.carriers[CARRIER_DUTY_FREE] ?? Object.values(table.carriers)[0]
}

export interface TramoCotizacion {
  costUsd: number
  /** Cuántas cajas hacen falta. 1 mientras el peso entre en una. */
  cajas: number
  /** El peso facturable de cada caja. Iguales entre sí (ver más abajo). */
  pesosKg: number[]
  /** El tope de peso por caja, para poder decirlo en pantalla. */
  capKg: number
}

/**
 * Cotiza el tramo India→USA de un peso cobrable cualquiera, PARTIÉNDOLO en cajas iguales
 * cuando no entra en una.
 *
 * Antes esto era un solo `find` con un `?? último escalón` al final, y ese fallback es el
 * que estaba mal: 24 kg pagaban la tarifa de 22 y 44 kg también. No es un redondeo — el
 * error crece sin techo con el peso (a 44 kg costeaba la mitad), y encima empuja justo para
 * el lado peligroso, porque el carril aéreo se abarata al juntar kilos y el simulador
 * premiaba seguir amontonando en una caja que ya no existe.
 *
 * EL REPARTO ES EN PARTES IGUALES, y es una decisión, no lo más barato posible. El reparto
 * más barato concentra: 24.42 kg salen $27.93 menos como 18.9 + 5.5 que como 12.21 + 12.21,
 * porque la tarifa baja por kilo cuanto más pesa la caja. Pero ese óptimo solo existe si
 * uno elige qué pieza va en cada caja, y no es lo que pasa: se despacha el bulto y lo
 * reparten. Cotizar el óptimo sería costear con un ahorro que no se va a lograr — y ese
 * error va para el lado que duele, porque el número termina en un precio de venta. Partes
 * iguales es el supuesto que se puede cumplir siempre.
 */
export function cotizarTramoAereo(
  weightKg: number,
  carrier: string,
  isMember: boolean,
  cfg?: Record<string, string>,
): TramoCotizacion {
  const table = resolveRateTable(cfg)
  const steps = pasosDe(carrier, cfg)
  const capKg = steps[steps.length - 1][0]
  const socio = (basic: number) => (isMember ? Number((basic * (1 - table.member_discount)).toFixed(2)) : basic)
  // El escalón que cubre ese peso. Nunca satura acá: por construcción cada caja pesa
  // como mucho el tope, que es el último escalón de la tabla.
  const escalon = (kg: number) => socio((steps.find(st => st[0] >= kg) ?? steps[steps.length - 1])[1])

  if (weightKg <= 0) return { costUsd: 0, cajas: 0, pesosKg: [], capKg }

  const cajas = Math.ceil(weightKg / capKg)
  const cada = weightKg / cajas

  return {
    costUsd: Number((escalon(cada) * cajas).toFixed(2)),
    cajas,
    pesosKg: Array.from({ length: cajas }, () => Number(cada.toFixed(2))),
    capKg,
  }
}
