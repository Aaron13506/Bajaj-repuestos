import { db } from './db'
import { calcEnvio, CM3_PER_FT3, type ConfigMap, type EnvioItemInput } from './calc'
import { expandCostPieces, makeProductLookup, type ProductCost } from './envio-build'
import type { BundlePiece } from './bundle'
import { loadConfig } from './quote-metrics'
import { inboundDe } from './inbound'

// ─────────────────────────────────────────────────────────────────────────────
// Cuánto pesa y cuánto ocupa un pedido — antes de que exista la caja.
//
// La página de envíos responde esto para una caja ya armada; acá se responde para
// un pedido, que es donde vive la pregunta del stock propio ("¿cuánto espacio me
// va a comer lo que traigo por mi cuenta?"). El cálculo NO se reimplementa: se
// arman los mismos `EnvioItemInput` y los mide `calcEnvio`, así el número coincide
// con el del envío y con `pnpm q` cuando esas piezas terminen embarcadas.
//
// Peso y volumen son aditivos, así que medir todos los pedidos en una sola pasada
// y después repartir las líneas por `pedidoId` da lo mismo que medirlos de a uno.
// El COSTO no lo es (la tabla escalón de ShipGlobal depende del total), por eso acá
// solo se expone lo físico.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogisticsMetrics {
  /** Peso real (kg). */
  realKg: number
  /** Peso volumétrico aéreo (kg). */
  volKg: number
  /** max(real, volumétrico) — lo que cobra el aéreo. */
  chargeableKg: number
  /** Espacio físico que ocupa: lo que cobra el marítimo y lo que hay que guardar. */
  ft3: number
  cbm: number
  /** Piezas que viajan (no landed) contadas en la medición. */
  piezas: number
  /** De ésas, cuántas no tienen peso o medidas cargadas: el total queda corto. */
  incompletas: number
}

const ZERO: LogisticsMetrics = {
  realKg: 0, volKg: 0, chargeableKg: 0, ft3: 0, cbm: 0, piezas: 0, incompletas: 0,
}

export function emptyLogistics(): LogisticsMetrics {
  return { ...ZERO }
}

export async function pedidoLogistics(
  pedidoIds: number[],
  opts: { cfg?: ConfigMap } = {},
): Promise<{ total: LogisticsMetrics; porPedido: Map<number, LogisticsMetrics> }> {
  const ids = [...new Set(pedidoIds)]
  if (ids.length === 0) return { total: emptyLogistics(), porPedido: new Map() }

  const [cfg, items] = await Promise.all([
    opts.cfg ? Promise.resolve(opts.cfg) : loadConfig(),
    db.pedidoItem.findMany({
      where: { pedidoId: { in: ids } },
      select: {
        pedidoId: true, productId: true, quantity: true, bundleItems: true,
        origen: true, inbound: true, supplierId: true, isLanded: true,
        product: {
          select: {
            id: true, nameEs: true, bajajCode: true,
            weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
          },
        },
      },
    }),
  ])

  // Las piezas de un conjunto se guardan como snapshot (nombre + SKU), no como
  // relación: hay que resolverlas contra el catálogo para saber lo que pesan. Un
  // ensamble sin expandir agrega TODAS sus piezas y sobreestima (ver expandCostPieces).
  const bundles = new Map<number, BundlePiece[]>()
  const codes = new Set<string>()
  const names = new Set<string>()
  for (const it of items) {
    const pieces = (it.bundleItems as BundlePiece[] | null) ?? []
    if (pieces.length === 0) continue
    bundles.set(it.productId, pieces)
    for (const p of pieces) {
      if (p.bajajCode) codes.add(p.bajajCode)
      names.add(p.nameEs)
    }
  }

  const piezasDeConjuntos = codes.size > 0 || names.size > 0
    ? await db.product.findMany({
        where: { OR: [{ bajajCode: { in: [...codes] } }, { nameEs: { in: [...names] } }] },
        select: {
          id: true, nameEs: true, bajajCode: true,
          weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
        },
      })
    : []

  const lookup = makeProductLookup([
    ...items.map(it => it.product as ProductCost),
    ...(piezasDeConjuntos as ProductCost[]),
  ])

  const inputs: EnvioItemInput[] = items.flatMap(it =>
    expandCostPieces(
      it.product as ProductCost,
      it.quantity,
      (it.bundleItems as BundlePiece[] | null),
      lookup,
    ).map(piece => ({
      pedidoId: it.pedidoId,
      productId: it.productId,
      name: piece.name,
      weightGrams: piece.weightGrams,
      dimL: piece.dimL,
      dimA: piece.dimA,
      dimH: piece.dimH,
      priceInr: piece.priceInr,
      quantity: piece.quantity,
      origen: it.origen === 'china' ? 'china' : 'india',
      inbound: inboundDe(it.origen, it.inbound),
      supplierId: it.supplierId,
      isLanded: it.isLanded,
    }))
  )

  const { lines } = calcEnvio(inputs, cfg)

  const acc = new Map<number, LogisticsMetrics>(ids.map(id => [id, emptyLogistics()]))
  for (const l of lines) {
    // Un ítem landed llega puesto en Venezuela: nunca ocupa la caja ni el depósito.
    if (l.isLanded) continue
    const m = acc.get(l.pedidoId)
    if (!m) continue
    m.realKg += l.realKg
    m.volKg += l.volKg
    m.ft3 += l.ft3
    m.piezas += 1
    if (l.missingWeight || l.missingDims) m.incompletas += 1
  }

  const total = emptyLogistics()
  for (const m of acc.values()) {
    m.chargeableKg = Math.max(m.realKg, m.volKg)
    m.cbm = (m.ft3 * CM3_PER_FT3) / 1_000_000
    total.realKg += m.realKg
    total.volKg += m.volKg
    total.ft3 += m.ft3
    total.piezas += m.piezas
    total.incompletas += m.incompletas
  }
  total.chargeableKg = Math.max(total.realKg, total.volKg)
  total.cbm = (total.ft3 * CM3_PER_FT3) / 1_000_000

  return { total, porPedido: acc }
}
