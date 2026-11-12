// ─────────────────────────────────────────────────────────────────────────────
// QUIÉN LLEVA LA CAJA DE INDIA A USA (cuando la mercancía pasa por un depósito)
//
// `inbound` (lib/inbound.ts) dice si el tramo a USA lo cobra un reenvío ('shoppre') o lo
// factura el proveedor ('cotizado'). Esto dice CUÁL reenvío, y es de la caja, no del
// proveedor: la misma compra a 99rpm puede ir por Shoppre o por el otro, según convenga.
// Se elige al crear la caja y se congela como el proveedor.
//
//   'shoppre'   tabla escalón de ShipGlobal en USD, seguro y processing de Shoppre.
//   'por_kilo'  no hay tabla: el precio por kilo depende del tamaño del envío y lo cotizan
//               en el momento, en RUPIAS (Envio.tarifaKgInr). El tramo es
//               kg cobrables (escalones de 0,5, mínimo 1 por caja) × ₹/kg, sin seguro. Sin tarifa cargada la caja queda
//               subcosteada, no gratis.
//
// El reempaque (Envio.reempaqueInr) es de cada caja en los dos: un paquete cuesta ₹100 y otro
// ₹1000, así que no hay número fijo que guardar en /config.
//
// Los dos reenvíos conviven también al cotizar. El catálogo muestra las dos rutas lado a
// lado (el por kilo con el ₹/kg de REFERENCIA de /config, `reenvio_kilo_tarifa_inr`), y cada
// presupuesto por Miami elige la suya (Pedido.reenvio + Pedido.tarifaKgInr, congelada al
// guardar). `reenvio_precios` solo dice con cuál nacen los presupuestos nuevos. El precio de
// venta del catálogo (Product.price, reprice) sigue saliendo de Shoppre.
//
// La referencia de /config NO es la tarifa de la caja: la caja real sigue con la que le
// cotizan a ella (Envio.tarifaKgInr), sin fallback. Y el pedido viaja solo en una caja de su
// mismo reenvío (motivoReenvioNoCoincide): si no, el precio que se le dijo al cliente y el
// costo de la caja saldrían de tarifas distintas.
// ─────────────────────────────────────────────────────────────────────────────

import { SHIPPING_STATUSES, statusIndex } from './shipping-status'
import { flag, type ConfigMap } from './config'

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

/**
 * ₹/kg de referencia (Config.reenvio_kilo_tarifa_inr). null = no cargada: la ruta por kilo no
 * se cotiza. No pasa por num(): su fallback inventaría una tarifa, y vacío no es cero.
 */
export function tarifaKgReferencia(cfg: ConfigMap): number | null {
  const raw = (cfg.reenvio_kilo_tarifa_inr ?? '').trim()
  if (raw === '') return null
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : null
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
