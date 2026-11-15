// "No tienen stock" por SKU (pestaña Comprar de la caja). El proveedor avisa por código, y un mismo
// código puede estar en varios pedidos: hay que decidir quién se queda esperando. Puro, sin DB.
import { statusIndex } from './shipping-status'

/**
 * Una línea que el proveedor no mandó (entera) espera DENTRO de su caja, pero no está en el depósito:
 * no avanza más allá de «camino al depósito», y la caja no sale del depósito con ella adentro. Antes
 * de despachar hay que decidir cada una: llegó, pasa a otra caja, queda para la próxima o reembolso.
 * Devuelve el motivo, o null si se puede.
 */
export function motivoNoDespacha(
  cambios: { hacia: string }[],
  sinDecidir: { nombre: string; pedidoId: number }[],
): string | null {
  if (sinDecidir.length === 0) return null
  if (!cambios.some(c => statusIndex(c.hacia) >= statusIndex('camino_usa'))) return null
  const lista = sinDecidir.slice(0, 3).map(s => `«${s.nombre}» (#${s.pedidoId})`).join(', ') + (sinDecidir.length > 3 ? '…' : '')
  return `La caja no sale del depósito con piezas que el proveedor no mandó: ${lista}. ` +
    'En la pestaña Comprar decidí qué pasa con cada una: llegó, pasa a otra caja, queda para la próxima o reembolso.'
}

/** Una línea que no vino no pasa de «camino al depósito»: no está ahí para avanzar. */
export const avanzaSinEstar = (hacia: string) => statusIndex(hacia) > statusIndex('camino_shoppre')

/** Un SKU como se compara: mayúsculas, sin espacios ni guiones ("jf-581 056" = "JF581056"). */
export const normSku = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Los códigos de un texto pegado ("JF581056, DH151039\nJN221145"): uno por palabra, sin repetir. */
export function tokensSku(texto: string): string[] {
  return [...new Set(texto.split(/[\s,;]+/).map(normSku).filter(t => t.length >= 2))]
}

export interface LineaConSku {
  key: string
  /** Unidades de ese SKU en la línea que todavía no están anotadas como "no vino". */
  disponibles: number
  propio: boolean
  pedidoId: number
}

/**
 * Reparte `n` unidades que el proveedor no tiene entre las líneas que llevan el SKU: primero el
 * stock propio (no hay cliente esperando), después el pedido más nuevo, así el que pagó primero
 * recibe primero. Nunca más de lo disponible por línea; lo que sobre de `n` no se asigna.
 */
export function repartirSinStock(lineas: LineaConSku[], n: number): Map<string, number> {
  const orden = [...lineas].sort((a, b) => (a.propio !== b.propio ? (a.propio ? -1 : 1) : b.pedidoId - a.pedidoId))
  const r = new Map<string, number>()
  let queda = Math.max(0, Math.floor(n))
  for (const l of orden) {
    const x = Math.min(queda, l.disponibles)
    r.set(l.key, x)
    queda -= x
  }
  return r
}

/**
 * «Separarla del conjunto»: el SKU que el proveedor no mandó sale del conjunto a una línea propia,
 * así puede esperar o cambiar de caja sola mientras el resto viaja. Si vino una parte (4 pedidas, 1
 * mandada), salen solo las que faltan y el conjunto se queda con las que vinieron; tienen que
 * repartirse parejo entre los sets de la línea. La plata se parte por lo que vale el SKU dentro del conjunto a precio de catálogo, al
 * centavo: lo vendido y lo pagado del pedido suman lo mismo que antes. `precio` = precio de
 * catálogo de una unidad, o null si la pieza no está en el catálogo.
 */
export function planSeparar(
  linea: { quantity: number; salePrice: number; costRealUsd: number | null; piezas: { nameEs: string; bajajCode: string | null; quantity: number }[] },
  i: number,
  unidades: number,
  precio: (p: { nameEs: string; bajajCode: string | null }) => number | null,
):
  | { ok: true; quedan: typeof linea.piezas; cantidad: number; precioNuevo: number; precioQueda: number; costoNuevo: number | null; costoQueda: number | null }
  | { ok: false; error: string } {
  const p = linea.piezas[i]
  const enLinea = p.quantity * linea.quantity
  const entera = unidades === enLinea
  if (entera && linea.piezas.length < 2) return { ok: false, error: 'El conjunto es solo esa pieza: ya espera como línea entera.' }
  // Por set: lo que sale de cada uno tiene que ser entero (2 sets y faltan 3 no se reparte).
  const porSet = unidades / linea.quantity
  if (unidades < 1 || unidades > enLinea || !Number.isInteger(porSet)) {
    return { ok: false, error: `Faltan ${unidades} de ${enLinea} «${p.nameEs}» repartidas en ${linea.quantity} sets: no se pueden separar parejo.` }
  }
  let total = 0
  for (const x of linea.piezas) {
    const v = precio(x)
    if (v == null) return { ok: false, error: `«${x.bajajCode ?? x.nameEs}» no está en el catálogo: no sé cuánto vale dentro del conjunto.` }
    total += v * x.quantity
  }
  if (total <= 0) return { ok: false, error: 'Las piezas del conjunto no tienen precio en el catálogo.' }
  const cent = (n: number) => Math.round(n * 100) / 100
  // Por unidad de la línea nueva: cada set suelta porSet unidades, así lo que sale de cada set es exacto.
  const ratio = (precio(p)! * p.quantity) / total
  const precioNuevo = cent((linea.salePrice * ratio) / p.quantity)
  const costoNuevo = linea.costRealUsd != null ? cent((linea.costRealUsd * ratio * porSet) / p.quantity) : null
  return {
    ok: true,
    quedan: entera
      ? linea.piezas.filter((_, k) => k !== i)
      : linea.piezas.map((x, k) => (k === i ? { ...x, quantity: x.quantity - porSet } : x)),
    cantidad: unidades,
    precioNuevo,
    precioQueda: cent(linea.salePrice - precioNuevo * porSet),
    costoNuevo,
    costoQueda: costoNuevo != null ? cent(linea.costRealUsd! - costoNuevo) : null,
  }
}
