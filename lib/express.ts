import { calcEnvio, calcPrecioBcv, cobrableConBanda, type EnvioBreakdown, type EnvioItemInput, type MedidasCaja, type ReenvioCaja } from './calc'
import { num, margenPorDefecto, type ConfigMap } from './config'
import { resolveRateTable, CARRIER_EXPRESS_VE } from './shipping-rates'

// ─────────────────────────────────────────────────────────────────────────────
// ENVÍO EXPRESS: India → Venezuela directo, por Shoppre
//
// La misma compra a 99rpm y el mismo depósito de Shoppre que la caja aérea, pero Shoppre la
// despacha directo a Caracas en vez de a Miami. Más rápido y más caro, y con
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
//
// EXPRESS POR USA: la caja express con reenvío por kilo. El reenvío la lleva DDP a Miami
// (₹/kg de la caja) y One Way Cargo en avión a Caracas ($/lb + $ por paquete, /config). Va
// DDP, así que NO tiene tope: es la salida para un paquete que pasa de $100. Se elige al
// crear la caja; el presupuesto la toma de la caja en la que va.
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
  /**
   * Lo que ya va en la caja express elegida para este presupuesto (las líneas de los otros
   * presupuestos). Viajan en el mismo paquete: el flete se calcula para todo junto y a este
   * presupuesto le toca su parte. El tope se mide contra el paquete entero.
   */
  acompanantes?: EnvioItemInput[]
  /** El reenvío de la caja elegida. Por kilo = express por USA, sin tope. Ausente = Shoppre directo. */
  reenvio?: ReenvioCaja | null
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
  /** El paquete entero: este presupuesto más lo que ya va en su caja. */
  envio: EnvioBreakdown
  /** Express por USA (reenvío por kilo + One Way aéreo): sin tope. */
  porUsa: boolean
  /** Por USA sin tarifa ₹/kg cotizada en la caja: el precio no lleva el tramo a Miami. */
  faltaTarifa: boolean
  topeUsd: number
  /** Landed de ESTE presupuesto (su parte del paquete). */
  landedUsd: number
  /** Landed del paquete entero, el que se mide contra el tope. */
  paqueteUsd: number
  /**
   * Kg cobrables y flete (Shoppre → VEN, o depósito → Miami + One Way) de ESTE presupuesto, su parte
   * del paquete. Sin pesar, el volumétrico entra con banda de tolerancia (cobrableConBanda).
   */
  chargeableKg: number
  fleteUsd: number
  /** tope − landed del paquete. Negativo = te pasaste por esa cantidad. */
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
  const acompanantes = opts.acompanantes ?? []
  const piezas = [...items, ...acompanantes].map(it => ({ ...it, inbound: 'shoppre' as const, isLanded: false }))
  const porUsa = opts.reenvio?.tipo === 'por_kilo'
  const envio = calcEnvio(piezas, cfg, {
    modo: 'express',
    medidas: opts.medidas ? [opts.medidas] : null,
    fleteFacturado: opts.fleteUsd != null ? { aereoUsd: opts.fleteUsd } : null,
    reenvio: opts.reenvio,
    bandaVolumetrico: true,
  })
  // Las líneas de este presupuesto van primero: calcEnvio devuelve una línea por ítem, en orden.
  const propias = envio.lines.slice(0, items.length)

  const topeUsd = topeExpressUsd(cfg)
  const landedUsd = propias.reduce((s, l) => s + l.landedUsd, 0)
  const holguraUsd = topeUsd - envio.landedUsd
  const seguro = num(cfg, 'shoppre_insurance_pct', 0.03)

  let kgHastaProximoEscalon: number | null = null
  if (!porUsa && opts.fleteUsd == null && envio.air.chargeableKg > 0) {
    const steps = resolveRateTable(cfg, 've').carriers[CARRIER_EXPRESS_VE] ?? []
    const kg = envio.air.chargeableKg
    const escalon = steps.find(st => st[0] >= kg)
    if (escalon) kgHastaProximoEscalon = Number((escalon[0] - kg).toFixed(3))
  }

  const margen = opts.margen ?? margenExpress(cfg)
  const lineas: LineaExpress[] = propias.map(l => ({
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    landedUsd: l.landedUsd,
    precioUnitUsd: margen < 1 && l.quantity > 0 ? round2(l.landedUsd / l.quantity / (1 - margen)) : 0,
  }))
  const precioUsd = round2(lineas.reduce((s, l) => s + l.precioUnitUsd * l.quantity, 0))

  return {
    envio,
    porUsa,
    faltaTarifa: envio.reenvio.faltaTarifa,
    topeUsd,
    landedUsd,
    paqueteUsd: envio.landedUsd,
    chargeableKg: cobrableConBanda(
      propias.reduce((s, l) => s + l.realKg, 0),
      propias.reduce((s, l) => s + l.volKg, 0),
      envio.caja.pesoKg != null && envio.caja.cm3 != null ? 0 : num(cfg, 'caja_sin_pesar_tolerancia_pct', 10) / 100,
    ),
    fleteUsd: propias.reduce((s, l) => s + l.airUsd + l.maritimeUsd, 0),
    holguraUsd,
    excede: !porUsa && holguraUsd < 0,
    productoQueEntraUsd: !porUsa && holguraUsd > 0 ? holguraUsd / (1 + seguro) : 0,
    kgHastaProximoEscalon,
    margen,
    precioUsd,
    precioUsdBcv: calcPrecioBcv(precioUsd, cfg)?.priceUsdBcv ?? null,
    gananciaUsd: precioUsd - landedUsd,
    lineas,
    sinPeso: envio.lines.filter(l => l.missingWeight).map(l => l.name),
  }
}

/**
 * El reenvío con el que se cotiza un presupuesto express. Con caja manda la ruta de la caja (es
 * por donde va a viajar), y por USA el ₹/kg del presupuesto, o el de la caja si no anotó uno. Sin
 * caja, la ruta que eligió el presupuesto (Pedido.reenvio). null = Shoppre directo.
 */
export function reenvioDelPresupuesto(
  ruta: string | null | undefined, tarifaKgInr: number | null, caja: ReenvioCaja | null,
): ReenvioCaja | null {
  if (caja) return caja.tipo === 'por_kilo' ? { ...caja, tarifaKgInr: tarifaKgInr ?? caja.tarifaKgInr } : null
  return ruta === 'por_kilo' ? { tipo: 'por_kilo', tarifaKgInr, reempaqueInr: null } : null
}

// ── El presupuesto express ───────────────────────────────────────────────────
// La vía es del presupuesto entero (Pedido.via), no de cada línea: el flete express es uno
// por paquete, así que el precio de cada pieza depende de todo lo que va en el paquete.

export type Via = 'normal' | 'express'

export function viaDe(v: string | null | undefined): Via {
  return v === 'express' ? 'express' : 'normal'
}

/**
 * Por qué un presupuesto express no se puede confirmar, o null si se puede. La comparten el
 * armador y la ficha (que avisan) y la confirmación (que es el candado real): confirmar es
 * comprometerse a traerlo, y un paquete pasado del tope no se puede despachar así.
 */
export function motivoExpressNoAprobable(e: Pick<Express, 'excede' | 'holguraUsd' | 'topeUsd' | 'sinPeso'> & { faltaTarifa?: boolean }): string | null {
  if (e.faltaTarifa) {
    return 'Va por USA y falta la tarifa ₹/kg del reenvío: sin ella el precio no lleva el tramo a Miami. Cargá la tabla por kilo en Configuración, o anotala en el presupuesto (Ruta express) o en la pestaña Plata de la caja.'
  }
  if (e.excede) {
    return `El paquete express se pasa ${(-e.holguraUsd).toFixed(2)} USD del tope de ${e.topeUsd.toFixed(2)} USD. Sacá piezas, mandalo por USA (sin tope) o pasalo a envío normal.`
  }
  if (e.sinPeso.length > 0) {
    return `Sin peso cargado: ${e.sinPeso.join(', ')}. Sin peso no se sabe cuánto cuesta el flete del paquete express.`
  }
  return null
}

/**
 * Por qué una línea de un presupuesto no entra en esta caja por su vía, o null si entra.
 *
 * - Un presupuesto express viaja solo en una caja express (nunca en una aérea normal: se le
 *   prometió entrega rápida).
 * - Una caja express directo (Shoppre, con tope de $100) lleva solo presupuestos express.
 * - Una caja express por USA (reenvío por kilo + One Way aéreo, sin tope) también acepta
 *   pedidos normales cotizados por kilo: comparten depósito y tarifa hasta Miami, solo acelera
 *   el último tramo. (No entran en el agregado masivo: se agregan de a uno.)
 */
export function motivoViaNoCoincide(
  via: string | null | undefined,
  modoCaja: string | null | undefined,
  reenvioPedido?: string | null,
  reenvioCaja?: string | null,
): string | null {
  const express = viaDe(via) === 'express'
  if (express && modoCaja !== 'express') return 'Es un presupuesto express: va en una caja express, no en esta.'
  if (!express && modoCaja === 'express') {
    if (reenvioCaja === 'por_kilo') {
      if (reenvioPedido === 'por_kilo') return null
      return 'Esta caja es express por kilo: para meter un pedido normal, cambiale el reenvío a por kilo (o pasalo a express).'
    }
    return 'Esta caja es express: lleva solo presupuestos express.'
  }
  return null
}

/**
 * Si una línea ya avanzó más allá de «pendiente» (comprada, servida del depósito o en camino):
 * una vez que pasa eso, la vía del pedido ya no se cambia. Compartido por ficha, editar y acciones.
 */
export function esLineaAvanzada(it: {
  shippingStatus: string
  costRealUsd: unknown
  desdeStock: boolean
}): boolean {
  return it.shippingStatus !== 'pendiente' || it.costRealUsd != null || it.desdeStock
}

/**
 * Por qué no se le puede cambiar la vía (normal ↔ express) a un pedido desde su ficha, sin
 * recotizar, o null si se puede. Solo pedidos confirmados (los presupuestos se cambian desde
 * Editar para que recoticen) mientras ninguna línea esté en una caja, comprada, servida del
 * depósito o avanzada más allá de pendiente. No toca precios ni cobros.
 */
export function motivoViaFija(p: {
  tipo: string
  status: string
  enCaja: boolean
  avanzado: boolean
}): string | null {
  if (p.tipo === 'venta') return 'Una venta del depósito ya está entregada.'
  if (p.status === 'cancelado') return 'Este pedido está cancelado.'
  if (p.status === 'presupuesto') return 'Es un presupuesto sin confirmar: cambiale la vía desde Editar para recotizar.'
  if (p.enCaja) return 'Ya tiene piezas en una caja: sacalas de la caja o movelas desde ahí.'
  if (p.avanzado) return 'Ya tiene piezas compradas, servidas del depósito o en camino: no se puede cambiar de vía.'
  return null
}

/** Lo que se le promete al cliente, contado desde que se hace la compra (Config express_plazo_dias). */
export function plazoExpress(cfg: ConfigMap): string {
  const raw = cfg.express_plazo_dias?.trim()
  return `${raw || '10 a 15'} días hábiles`
}

/**
 * El tope aplicado a una caja express ya armada (su calcEnvio en modo 'express', con la caja
 * pesada y el flete facturado si se cargaron). Misma forma que pide motivoExpressNoAprobable.
 */
export function topeDeCaja(calc: EnvioBreakdown, cfg: ConfigMap): Pick<Express, 'excede' | 'holguraUsd' | 'topeUsd' | 'sinPeso'> {
  const topeUsd = topeExpressUsd(cfg)
  const holguraUsd = topeUsd - calc.landedUsd
  return { topeUsd, holguraUsd, excede: holguraUsd < 0, sinPeso: calc.lines.filter(l => l.missingWeight).map(l => l.name) }
}
