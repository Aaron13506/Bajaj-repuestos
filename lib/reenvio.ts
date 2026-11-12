// ─────────────────────────────────────────────────────────────────────────────
// QUIÉN LLEVA LA CAJA DE INDIA A USA (cuando la mercancía pasa por un depósito)
//
// `inbound` (lib/inbound.ts) dice si el tramo a USA lo cobra un reenvío ('shoppre') o lo
// factura el proveedor ('cotizado'). Esto dice CUÁL reenvío, y es de la caja, no del
// proveedor: la misma compra a 99rpm puede ir por Shoppre o por el otro, según convenga.
// Se elige al crear la caja y se congela como el proveedor.
//
//   'shoppre'   tabla escalón de ShipGlobal en USD, seguro y processing de Shoppre.
//   'por_kilo'  tabla escalón en RUPIAS por peso de caja (Config.reenvio_kilo_tarifa_inr, ver
//               `tablaPorKilo`): kg cobrables (escalones de 0,5, mínimo 1 por caja) × el ₹/kg de
//               su tramo, sin seguro. Una caja con su propia tarifa cotizada (Envio.tarifaKgInr)
//               la usa en lugar de la tabla. Sin ninguna de las dos la caja queda subcosteada,
//               no gratis.
//
// El reempaque (Envio.reempaqueInr) es de cada caja en los dos: un paquete cuesta ₹100 y otro
// ₹1000, así que no hay número fijo que guardar en /config.
//
// Los dos reenvíos conviven también al cotizar. El catálogo muestra las dos rutas lado a
// lado (el por kilo con el ₹/kg de REFERENCIA: la tabla en la caja de referencia, como Shoppre), y cada
// presupuesto por Miami elige la suya (Pedido.reenvio + Pedido.tarifaKgInr, congelada al
// guardar). `reenvio_precios` solo dice con cuál nacen los presupuestos nuevos. El precio de
// venta del catálogo (Product.price, reprice) sigue saliendo de Shoppre.
//
// La caja real se costea con la tabla por SU peso (o con la tarifa que le cotizaron a ella),
// no con la referencia por kilo de una caja promedio. Y el pedido viaja solo en una caja de su
// mismo reenvío (motivoReenvioNoCoincide): si no, el precio que se le dijo al cliente y el
// costo de la caja saldrían de tarifas distintas.
// ─────────────────────────────────────────────────────────────────────────────

import { SHIPPING_STATUSES, statusIndex } from './shipping-status'
import { flag, num, type ConfigMap } from './config'

export type Reenvio = 'shoppre' | 'por_kilo'

export const REENVIOS: { value: Reenvio; label: string; hint: string }[] = [
  {
    value: 'shoppre',
    label: 'Shoppre',
    hint: 'Tabla escalón de ShipGlobal en USD. Suma seguro y processing.',
  },
  {
    value: 'por_kilo',
    label: 'Reenvío por kilo',
    hint: 'Te cotizan ₹/kg al momento. Tramo = kg cobrables × ₹/kg + el reempaque de la caja. Sin seguro.',
  },
]

export function isReenvio(v: string | null | undefined): v is Reenvio {
  return v === 'shoppre' || v === 'por_kilo'
}

export function reenvioDe(v: string | null | undefined): Reenvio {
  return isReenvio(v) ? v : 'shoppre'
}

export function reenvioMeta(r: Reenvio) {
  return REENVIOS.find(x => x.value === r)!
}

/**
 * Los kg que factura el reenvío por kilo por UNA caja: escalones de 0,5 kg hacia arriba, con
 * mínimo de 1 kg (0,3 → 1; 1,2 → 1,5; 2,5 → 2,5). Sin carga no hay nada que facturar.
 */
export function kgFacturadosPorKilo(kg: number): number {
  if (kg <= 0) return 0
  // toFixed: que 2,5 calculado como 2,5000000001 no salte al escalón de 3.
  return Math.max(1, Math.ceil(Number((kg / 0.5).toFixed(6))) * 0.5)
}

/** Etapas desde las que la mercancía ya dejó el depósito rumbo a USA. */
export const ETAPAS_FUERA_DEL_DEPOSITO = SHIPPING_STATUSES
  .filter(s => statusIndex(s.value) >= statusIndex('camino_usa'))
  .map(s => s.value as string)

// ─────────────────────────────────────────────────────────────────────────────
// Tarifa de equilibrio: el ₹/kg máximo que conviene aceptar del reenvío por kilo
//
// Lo que esta caja pagaría por Shoppre (tabla + seguro + processing, todo estimado) contra lo
// que pagaría por kilo: kg × t ÷ tasa. El reempaque se paga igual por los dos y se cancela.
// Igualando y despejando t:
//
//   t = shoppreUsd × tasa ÷ kg cobrables
//
// Con una cotización por debajo, conviene el reenvío por kilo. Se compara estimado contra
// estimado a propósito: es para decidir antes de comprar, cuando no hay factura de ninguno.
// ─────────────────────────────────────────────────────────────────────────────

export function tarifaEquilibrioKgInr(p: {
  shoppreUsd: number
  chargeableKg: number
  inrUsd: number
}): number | null {
  if (p.chargeableKg <= 0 || p.inrUsd <= 0) return null
  return Math.max(0, (p.shoppreUsd * p.inrUsd) / p.chargeableKg)
}

// ─────────────────────────────────────────────────────────────────────────────
// La tarifa de REFERENCIA para cotizar (catálogo y presupuestos), no la de la caja
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// La tabla del reenvío por kilo (Config.reenvio_kilo_tarifa_inr), en JSON
//
// Un arreglo de tramos en orden de peso, todos con la misma forma:
//   { "hastaKg": 4, "inr": 9878, "total": true }    ← una caja de hasta 4 kg cuesta ₹9878 entera ("all in")
//   { "hastaKg": 5, "inr": 1760, "total": false }   ← de más de 4 hasta 5 kg, ₹1760 por kg
// Un número solo (1230) es una tarifa plana por kg.
//
// Pasado el último tramo sigue su tarifa. La caja cae en el tramo de sus kg facturados.
// ─────────────────────────────────────────────────────────────────────────────

export type TramoPorKilo = { hastaKg: number; inr: number; total: boolean }

const positivo = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** La tabla guardada en /config, o null si está vacía o no es válida (nunca una a medias). */
export function parsearTablaPorKilo(raw: string | null | undefined): TramoPorKilo[] | null {
  let json: unknown
  try { json = JSON.parse((raw ?? '').trim()) } catch { return null }
  if (positivo(json)) return [{ hastaKg: Infinity, inr: json, total: false }]
  if (!Array.isArray(json) || json.length === 0) return null
  const tabla: TramoPorKilo[] = []
  for (const t of json as Record<string, unknown>[]) {
    const claves = t && typeof t === 'object' ? Object.keys(t).sort().join(',') : ''
    const previo = tabla.at(-1)?.hastaKg ?? 0
    if (!positivo(t.hastaKg) || t.hastaKg <= previo) return null
    if (claves !== 'hastaKg,inr,total' || !positivo(t.inr) || typeof t.total !== 'boolean') return null
    tabla.push({ hastaKg: t.hastaKg, inr: t.inr, total: t.total })
  }
  return tabla
}

export function tablaPorKilo(cfg: ConfigMap): TramoPorKilo[] | null {
  return parsearTablaPorKilo(cfg.reenvio_kilo_tarifa_inr)
}

/** ₹ que cobra la tabla por UNA caja de estos kg facturados (kgFacturadosPorKilo). */
export function costoTablaPorKiloInr(tabla: TramoPorKilo[], kgFacturados: number): number {
  if (kgFacturados <= 0) return 0
  const t = tabla.find(x => kgFacturados <= x.hastaKg) ?? tabla[tabla.length - 1]
  return t.total ? t.inr : kgFacturados * t.inr
}

/**
 * ₹/kg de referencia para cotizar una pieza suelta: lo que cobra la tabla por kg en la caja de
 * referencia (reference_weight_kg), igual que Shoppre prorratea su tabla. null = sin tabla: la
 * ruta por kilo no se cotiza. Vacío no es cero.
 */
export function tarifaKgReferencia(cfg: ConfigMap): number | null {
  const tabla = tablaPorKilo(cfg)
  if (!tabla) return null
  const kg = kgFacturadosPorKilo(num(cfg, 'reference_weight_kg', 15))
  return Math.round((costoTablaPorKiloInr(tabla, kg) / kg) * 100) / 100
}

/**
 * Si el catálogo (/products, ficha de producto y de ensamble) muestra el bloque por kilo: hace
 * falta la tarifa de referencia y que Config.reenvio_kilo_en_catalogo no esté apagado. Solo es
 * vista: los presupuestos siguen pudiendo cotizar por kilo.
 */
export function verPorKiloEnCatalogo(cfg: ConfigMap): boolean {
  return tarifaKgReferencia(cfg) != null && flag(cfg, 'reenvio_kilo_en_catalogo', true)
}

/**
 * Con cuál reenvío nacen los presupuestos normales nuevos (Config.reenvio_precios). Sin tarifa
 * de referencia, siempre Shoppre: un presupuesto por kilo sin tarifa no se podría guardar.
 */
export function reenvioPorDefecto(cfg: ConfigMap): Reenvio {
  return reenvioDe(cfg.reenvio_precios?.trim()) === 'por_kilo' && tarifaKgReferencia(cfg) != null
    ? 'por_kilo'
    : 'shoppre'
}

/**
 * El reenvío con el que se costea un presupuesto NORMAL (por Miami), o null si es Shoppre (lo
 * de siempre). Por kilo: la tarifa del presupuesto, si no la de referencia; puede quedar null
 * (falta la tarifa: no se costea con 0).
 */
export function reenvioDelPresupuestoNormal(
  ruta: string | null | undefined,
  tarifaKgInr: number | null,
  cfg: ConfigMap,
): { tipo: 'por_kilo'; tarifaKgInr: number | null } | null {
  if (ruta !== 'por_kilo') return null
  return { tipo: 'por_kilo', tarifaKgInr: tarifaKgInr ?? tarifaKgReferencia(cfg) }
}

/**
 * La ruta de un presupuesto tal como llega del armador (`reenvio` + `tarifaKgInr`), o el motivo
 * para rechazarla. Pura: la usa la acción al guardar y la cubre check:costeo.
 *
 * - Express: igual que siempre. Shoppre directo o por USA; vacío = sin tarifa propia (usa la de
 *   la caja).
 * - Normal (por Miami): Shoppre, o por kilo con su ₹/kg. Vacío = la tarifa de referencia de
 *   /config, congelada en el presupuesto (mover la de config no re-costea lo ya dicho al
 *   cliente). Sin ninguna de las dos no se guarda: nunca se costea con 0.
 *
 * Un número ilegible o negativo se rechaza en las dos (un 0 escrito es un dato).
 */
export function leerRutaPresupuesto(
  raw: string | null | undefined,
  tarifaRaw: string | null | undefined,
  via: 'normal' | 'express',
  cfg: ConfigMap,
): { reenvio: Reenvio; tarifaKgInr: number | null } | { error: string } {
  const r = (raw ?? '').trim()
  if (r && !isReenvio(r)) return { error: via === 'express' ? 'Esa ruta express no existe.' : 'Ese reenvío no existe.' }
  const reenvio = reenvioDe(r)
  if (reenvio !== 'por_kilo') return { reenvio, tarifaKgInr: null }
  const t = (tarifaRaw ?? '').trim()
  if (t) {
    const n = Number(t.replace(',', '.'))
    if (!Number.isFinite(n) || n < 0) return { error: 'Revisá la tarifa ₹/kg: no es un número válido.' }
    return { reenvio, tarifaKgInr: n }
  }
  if (via === 'express') return { reenvio, tarifaKgInr: null }
  const ref = tarifaKgReferencia(cfg)
  if (ref == null) return { error: 'Falta la tarifa ₹/kg del reenvío por kilo: anotala acá o en Configuración.' }
  return { reenvio, tarifaKgInr: ref }
}

// ─────────────────────────────────────────────────────────────────────────────
// El pedido viaja en una caja de su mismo reenvío
//
// El reenvío de un presupuesto por Miami decide en qué caja aérea viaja: uno cotizado por kilo
// entra solo en una caja aérea por kilo, y uno por Shoppre solo en una caja Shoppre. Si no, el
// precio que se le dijo al cliente y el costo de la caja saldrían de tarifas distintas. Es la
// misma regla que separa express de normal (motivoViaNoCoincide), y se BLOQUEA, no se avisa.
// La traba es al ENTRAR: lo que ya viaja no se revisa.
// ─────────────────────────────────────────────────────────────────────────────

const ETIQUETA_REENVIO: Record<Reenvio, string> = { shoppre: 'Shoppre', por_kilo: 'por kilo' }

/**
 * Por qué un pedido NORMAL no entra en esta caja aérea por su reenvío, o null si entra. Solo opina
 * entre un pedido por Miami y una caja aérea: express contra express no cambia (ahí manda la ruta
 * de la caja, reenvioDelPresupuesto). Una caja cuyo proveedor despacha él mismo (`cotizado`) no
 * pasa por ningún depósito: el reenvío no aplica y entra cualquier pedido.
 */
export function motivoReenvioNoCoincide(
  pedido: { via: string | null | undefined; reenvio: string | null | undefined },
  caja: { modo: string | null | undefined; reenvio: string | null | undefined; despachaProveedor?: boolean },
): string | null {
  // viaDe (lib/express) en línea: importarlo cerraría un ciclo express → calc → reenvio.
  if (pedido.via === 'express' || caja.modo !== 'aereo' || caja.despachaProveedor) return null
  const delPedido = reenvioDe(pedido.reenvio)
  const deLaCaja = reenvioDe(caja.reenvio)
  if (delPedido === deLaCaja) return null
  return `Este pedido se cotizó ${delPedido === 'por_kilo' ? 'por kilo' : 'por Shoppre'}: va en una caja aérea ` +
    `${ETIQUETA_REENVIO[delPedido]}, no en esta (${ETIQUETA_REENVIO[deLaCaja]}). Cambiale el reenvío al pedido o usá otra caja.`
}

/**
 * Por qué no se le puede cambiar el reenvío a este pedido (desde su ficha, sin recotizar), o null
 * si se puede. Solo por Miami; y mientras ninguna línea esté en una caja (con una adentro, manda
 * la caja). No toca precios ni cobros: solo dice por dónde va a viajar.
 */
export function motivoReenvioFijo(p: { via: string | null | undefined; status: string; enCaja: boolean }): string | null {
  if (p.via === 'express') return 'Es express: la ruta es la de su caja express.'
  if (p.status === 'cancelado') return 'Este pedido está cancelado.'
  if (p.enCaja) return 'Ya tiene piezas en una caja: el reenvío es el de la caja.'
  return null
}
