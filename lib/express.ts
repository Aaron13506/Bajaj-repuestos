import { calcEnvio, calcPrecioBcv, type EnvioBreakdown, type EnvioItemInput, type MedidasCaja } from './calc'
import { num, margenPorDefecto, type ConfigMap } from './config'
import { resolveRateTable, CARRIER_EXPRESS_VE } from './shipping-rates'

// ─────────────────────────────────────────────────────────────────────────────
// ENVÍO EXPRESS: India → Venezuela directo, por Shoppre
//
// La misma compra a 99rpm y el mismo depósito de Shoppre que la caja aérea, pero Shoppre la
// despacha directo a Caracas (3 a 6 días) en vez de a Miami. Más rápido y más caro, y con
// una regla que la caja aérea no tiene:
//
//   EL LANDED DEL PAQUETE NO PUEDE PASAR DE `express_tope_usd` ($100).
//
// Es el landed entero (producto + flete + seguro + processing), y es POR PAQUETE: cada
// envío express por separado. No es lo que paga el cliente: el precio de venta puede pasar
// de $100 sin problema.
//
// El costeo es `calcEnvio` en modo 'express' (tabla de Venezuela, sin marítimo), así que da
// el mismo número que va a dar la caja real. Acá solo se agrega lo propio del express: el
// tope, cuánto queda, y el precio, que sale del landed del paquete con su propio margen
// (`express_margen_pct`) y NO del precio de catálogo, que lleva adentro un flete por
// Miami y un marítimo que este paquete no paga.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpressOptions {
  /**
   * Lo que cobró Shoppre por el paquete, processing incluido (así viene su factura). Pisa a la
   * tabla. null/ausente = se usa la tabla de Venezuela.
   */
  fleteUsd?: number | null
  /** El paquete como lo pesó y midió Shoppre. Reemplaza a la suma de las piezas. */
  medidas?: MedidasCaja | null
  /** Margen en fracción (0.3). Ausente = `express_margen_pct`, y si no, el margen por defecto. */
  margen?: number
}

export interface LineaExpress {
  productId: number | null
  name: string
  quantity: number
  /** Landed de la línea entera (todas sus unidades). */
  landedUsd: number
  /** Precio de venta por unidad, redondeado al centavo. */
  precioUnitUsd: number
}

export interface Express {
  envio: EnvioBreakdown
  topeUsd: number
  landedUsd: number
  /** tope − landed. Negativo = te pasaste por esa cantidad. */
  holguraUsd: number
  excede: boolean
  /**
   * Cuánto producto más entra antes del tope SI el flete no cambia de escalón. El seguro va
   * sobre el producto, así que cada dólar de mercancía cuesta 1 + seguro. 0 si ya te pasaste.
   */
  productoQueEntraUsd: number
  /** Kg cobrables que quedan hasta que la tabla salta al escalón siguiente. null con flete cargado a mano. */
  kgHastaProximoEscalon: number | null
  margen: number
  /** Suma de los precios de venta (unitario redondeado × cantidad). */
  precioUsd: number
  /** El mismo precio cotizado en dólares BCV (lo que se le dice al cliente). null sin tasa BCV. */
  precioUsdBcv: number | null
  gananciaUsd: number
  lineas: LineaExpress[]
  /** Piezas sin peso: el flete es un piso, no un costo. */
  sinPeso: string[]
}

export function topeExpressUsd(cfg: ConfigMap): number {
  return num(cfg, 'express_tope_usd', 100)
}

export function margenExpress(cfg: ConfigMap): number {
  const raw = cfg.express_margen_pct?.trim()
  return raw ? num(cfg, 'express_margen_pct', 0) / 100 : margenPorDefecto(cfg)
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function calcExpress(items: EnvioItemInput[], cfg: ConfigMap, opts: ExpressOptions = {}): Express {
  // Todo lo que va por express pasa por el depósito de Shoppre: se fuerza el inbound para
  // que una línea vieja o mal snapshoteada no se cueste como tramo cotizado.
  const envio = calcEnvio(
    items.map(it => ({ ...it, inbound: 'shoppre' as const, isLanded: false })),
    cfg,
    {
      modo: 'express',
      medidas: opts.medidas,
      fleteFacturado: opts.fleteUsd != null ? { aereoUsd: opts.fleteUsd } : null,
    },
  )

  const topeUsd = topeExpressUsd(cfg)
  const landedUsd = envio.landedUsd
  const holguraUsd = topeUsd - landedUsd
  const seguro = num(cfg, 'shoppre_insurance_pct', 0.03)

  let kgHastaProximoEscalon: number | null = null
  if (opts.fleteUsd == null && envio.air.chargeableKg > 0) {
    const steps = resolveRateTable(cfg, 've').carriers[CARRIER_EXPRESS_VE] ?? []
    const kg = envio.air.chargeableKg
    const escalon = steps.find(st => st[0] >= kg)
    if (escalon) kgHastaProximoEscalon = Number((escalon[0] - kg).toFixed(3))
  }

  const margen = opts.margen ?? margenExpress(cfg)
  const lineas: LineaExpress[] = envio.lines.map(l => ({
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    landedUsd: l.landedUsd,
    precioUnitUsd: margen < 1 && l.quantity > 0 ? round2(l.landedUsd / l.quantity / (1 - margen)) : 0,
  }))
  const precioUsd = round2(lineas.reduce((s, l) => s + l.precioUnitUsd * l.quantity, 0))

  return {
    envio,
    topeUsd,
    landedUsd,
    holguraUsd,
    excede: holguraUsd < 0,
    productoQueEntraUsd: holguraUsd > 0 ? holguraUsd / (1 + seguro) : 0,
    kgHastaProximoEscalon,
    margen,
    precioUsd,
    precioUsdBcv: calcPrecioBcv(precioUsd, cfg)?.priceUsdBcv ?? null,
    gananciaUsd: precioUsd - landedUsd,
    lineas,
    sinPeso: envio.lines.filter(l => l.missingWeight).map(l => l.name),
  }
}
