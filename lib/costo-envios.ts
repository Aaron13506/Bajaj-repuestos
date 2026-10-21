import { Prisma } from '@prisma/client'
import { db } from './db'
import { calcEnvio, type ConfigMap, type EnvioBreakdown, type EnvioItemInput, type ProveedorEnvio } from './calc'
import { toConfigMap } from './config'
import { reenvioDe } from './reenvio'
import { resumirCbm, costoEmbarque, type CbmResumen, type CostoEmbarque } from './cbm'
import { inboundDe } from './inbound'
import { modoDeEnvio } from './modo'
import { expandCostPieces, lookupDeConjuntos, repartirCostoReal, type ProductCost, type ProductLookup } from './envio-build'
import type { BundlePiece } from './bundle'
import { CATEGORIAS_FLETE, porSalirDeCaja } from './flete-real'
import { cuentasPorPagar, type EnvioPendiente } from './movimientos'

// Lo que la lista de envíos muestra por caja. Se calcula EN VIVO, con el mismo costeo que la
// ficha de cada una (calcEnvio en aéreo, costoEmbarque/resumirCbm en marítimo).
//
// Antes la lista leía `Envio.shippingCostEst`, una copia guardada a mano con un botón que
// solo existía en la ficha aérea: el marítimo nunca la escribía, y en el aéreo quedaba vieja
// apenas se cargaba un peso, un precio real o se movía una tasa. Un número que hay que
// acordarse de refrescar es un número que miente; el costo se deriva, no se guarda.
export interface CostoEnvio {
  nombre: string | null
  borrador: boolean
  /** Lo que cuesta MOVER la caja: tramos + marítimo + FOB (el facturado donde ya se cargó). */
  fleteUsd: number
  /**
   * El flete por transportista, lo que se paga con `flete_aereo` / `flete_maritimo`: Shoppre
   * (tabla + processing + seguro, o su factura) y Miami→Caracas o la naviera. Sin el tramo
   * cotizado ni el FOB: esos se le pagan al proveedor y van en cuentasPorPagar.
   */
  fleteAereoUsd: number
  fleteMaritimoUsd: number
  /** El tramo tiene su factura guardada en la caja: su flete es ese monto, no un estimado. */
  facturadoAereo: boolean
  facturadoMaritimo: boolean
  /** Mercancía + flete + cargos + comisiones. */
  landedUsd: number
  /** La mercancía sola: el precio real pagado donde se cargó, el de catálogo donde no. */
  mercanciaUsd: number
  /** Líneas con precio real cargado / líneas totales. Solo el aéreo lo lleva (el marítimo no tiene). */
  conCostoReal: number
  lineas: number
  /** Marítimo en borrador o sin volumen medido: el flete es un piso. */
  incompleto: boolean
}

const dec = (v: { toString(): string } | null | undefined) => (v != null ? parseFloat(v.toString()) : null)

const PRODUCTO_COSTEO = {
  select: {
    id: true, nameEs: true, bajajCode: true,
    weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
  },
} as const

// Lo que hace falta leer de una caja para costearla. Lo comparten la lista de envíos y el
// inventario (lib/inventario.ts): los dos tienen que dar el mismo número que la ficha.
export const ENVIO_COSTEO_INCLUDE = {
  items: {
    select: {
      id: true, productId: true, pedidoId: true, quantity: true, bundleItems: true, costRealUsd: true,
      origen: true, inbound: true, isLanded: true, supplierId: true, shippingStatus: true,
      pedido: { select: { tipo: true } },
      product: PRODUCTO_COSTEO,
    },
  },
  lineas: {
    select: { id: true, productId: true, quantity: true, product: PRODUCTO_COSTEO },
  },
  supplier: { select: { id: true, name: true, fobUsd: true } },
} satisfies Prisma.EnvioInclude

export type EnvioCosteo = Prisma.EnvioGetPayload<{ include: typeof ENVIO_COSTEO_INCLUDE }>

// Tasas, precios de proveedor y el lookup de las piezas de los conjuntos: lo que se arma
// una vez y sirve para costear muchas cajas.
export interface ContextoCosteo {
  cfg: ConfigMap
  lookup: ProductLookup
  precioProveedor: Map<string, number>
  preciosDe: (supplierId: number | null) => Map<number, { priceUsd: number; isLanded: boolean }>
}

export async function contextoCosteo(envios: EnvioCosteo[]): Promise<ContextoCosteo> {
  const [cfgRows, precios, lookup] = await Promise.all([
    db.config.findMany(),
    db.supplierPrice.findMany({ select: { productId: true, supplierId: true, priceUsd: true, isLanded: true } }),
    lookupDeConjuntos(envios.flatMap(e => e.items.map(i => i.bundleItems as BundlePiece[] | null))),
  ])
  const precioProveedor = new Map(precios.map(p => [`${p.supplierId}:${p.productId}`, parseFloat(p.priceUsd.toString())]))
  return {
    cfg: toConfigMap(cfgRows),
    lookup,
    precioProveedor,
    preciosDe: supplierId =>
      new Map(
        precios
          .filter(p => supplierId != null && p.supplierId === supplierId)
          .map(p => [p.productId, { priceUsd: parseFloat(p.priceUsd.toString()), isLanded: p.isLanded }]),
      ),
  }
}

export interface CosteoAereo {
  calc: EnvioBreakdown
  /** El PedidoItem de cada línea de `calc.lines` (mismo orden): un conjunto se expande en varias. */
  itemIdDeLinea: number[]
}

// Una caja aérea con calcEnvio, igual que la ficha: cada conjunto expandido a sus piezas, el
// costo real repartido entre ellas, la caja pesada y el flete facturado donde se cargaron.
export function costearAereo(e: EnvioCosteo, ctx: ContextoCosteo): CosteoAereo {
  const inrUsd = parseFloat(ctx.cfg.inr_usd_rate ?? '95')
  const itemIdDeLinea: number[] = []
  const piezas = e.items.flatMap(it => {
    const expandidas = expandCostPieces(
      it.product as ProductCost | null, it.quantity, it.bundleItems as BundlePiece[] | null, ctx.lookup,
    )
    const priceUsdDe = (productId: number | null) =>
      it.supplierId != null && productId != null
        ? ctx.precioProveedor.get(`${it.supplierId}:${productId}`) ?? null
        : null
    const reales = repartirCostoReal(
      dec(it.costRealUsd),
      expandidas.map(p => (priceUsdDe(p.productId) ?? (p.priceInr ?? 0) / inrUsd) * p.quantity),
    )
    return expandidas.map((p, idx): EnvioItemInput => {
      itemIdDeLinea.push(it.id)
      return {
        pedidoId: it.pedidoId,
        productId: p.productId,
        name: p.name,
        weightGrams: p.weightGrams,
        dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
        priceInr: p.priceInr,
        priceUsd: priceUsdDe(p.productId),
        costoRealUsd: reales[idx],
        quantity: p.quantity,
        origen: it.origen === 'china' ? 'china' : 'india',
        inbound: inboundDe(it.origen, it.inbound),
        supplierId: it.supplierId,
        isLanded: it.isLanded,
      }
    })
  })

  const proveedor: ProveedorEnvio | null = e.supplier
    ? {
        supplierId: e.supplier.id,
        nombre: e.supplier.name,
        tramoUsd: dec(e.tramoUsd),
        comisionSalienteUsd: dec(e.comisionSalienteUsd),
        comisionEntranteUsd: dec(e.comisionEntranteUsd),
      }
    : null
  const calc = calcEnvio(piezas, ctx.cfg, {
    proveedor,
    modo: modoDeEnvio(e.modo),
    reenvio: { tipo: reenvioDe(e.reenvio), tarifaKgInr: dec(e.tarifaKgInr) },
    medidas: {
      pesoKg: dec(e.pesoRealKg),
      dimL: e.cajaL, dimA: e.cajaA, dimH: e.cajaH,
    },
    fleteFacturado: {
      aereoUsd: dec(e.shippingCostRealAereo),
      maritimoUsd: dec(e.shippingCostRealMaritimo),
    },
  })
  return { calc, itemIdDeLinea }
}

export interface CosteoMaritimo {
  resumen: CbmResumen
  emb: CostoEmbarque
  /** Flete facturable + FOB; 0 si la caja no tiene volumen (el mínimo no se cobra a una caja vacía). */
  fleteUsd: number
  /** Mercancía + flete facturable + FOB + comisiones del giro: lo que cuesta la caja puesta acá. */
  landedUsd: number
}

export function costearMaritimo(e: EnvioCosteo, ctx: ContextoCosteo): CosteoMaritimo {
  const fob = dec(e.supplier?.fobUsd)
  const resumen = resumirCbm(
    e.lineas.map(l => ({
      itemId: l.id, pedidoId: 0, productId: l.productId, quantity: l.quantity,
      salePrice: 0, bundleItems: null, product: l.product as ProductCost,
    })),
    () => undefined,
    ctx.cfg,
    { priceMap: ctx.preciosDe(e.supplierId), fobUsd: fob },
  )
  const emb = costoEmbarque(resumen.volumeM3, ctx.cfg, fob, {
    mercanciaUsd: resumen.costoOrigenUsd,
    comisionSalienteUsd: dec(e.comisionSalienteUsd),
    comisionEntranteUsd: dec(e.comisionEntranteUsd),
  })
  // Sin volumen no hay caja que cobrar: el mínimo facturable no se aplica a un embarque
  // vacío (mismo corte que la ficha).
  const fleteUsd = resumen.volumeM3 > 0 ? emb.totalUsd : 0
  return { resumen, emb, fleteUsd, landedUsd: resumen.costoOrigenUsd + fleteUsd + emb.comisionUsd }
}

// Solo se costean las cajas VIVAS. Las ya cerradas (un marítimo recibido, o un aéreo con todas
// sus líneas entregadas) no cambian y dejaron de decidir nada: costearlas en cada render de
// /envios traía todos sus ítems, líneas y piezas de conjuntos, y eso crece sin techo con el
// historial. Su costo sigue a la vista en la ficha de la caja, que las costea una por una.
export async function costearEnvios(): Promise<Map<number, CostoEnvio>> {
  const envios = await db.envio.findMany({
    where: {
      NOT: [
        { modo: 'maritimo_cbm', estado: 'entregado' },
        { items: { some: {}, every: { shippingStatus: 'entregado' } } },
      ],
    },
    include: ENVIO_COSTEO_INCLUDE,
  })
  const ctx = await contextoCosteo(envios)

  const out = new Map<number, CostoEnvio>()
  for (const e of envios) {
    if (e.modo === 'maritimo_cbm') {
      const m = costearMaritimo(e, ctx)
      out.set(e.id, {
        nombre: e.nombre,
        borrador: e.estado === 'borrador',
        fleteUsd: m.fleteUsd,
        fleteAereoUsd: 0,
        fleteMaritimoUsd: m.resumen.volumeM3 > 0 ? m.emb.fleteUsd : 0,
        facturadoAereo: false,
        facturadoMaritimo: false,
        landedUsd: m.landedUsd,
        mercanciaUsd: m.resumen.costoOrigenUsd,
        conCostoReal: 0,
        lineas: e.lineas.length,
        incompleto: e.estado === 'borrador' || m.resumen.sinMedidas > 0,
      })
      continue
    }

    const { calc } = costearAereo(e, ctx)
    out.set(e.id, {
      nombre: e.nombre,
      borrador: e.estado === 'borrador',
      fleteUsd: calc.airUsd + calc.maritimeUsd + calc.fobUsd,
      fleteAereoUsd: calc.airUsd - (calc.tramo?.costUsd ?? 0) + calc.processingUsd + calc.insuranceUsd,
      fleteMaritimoUsd: calc.maritimeUsd,
      facturadoAereo: e.shippingCostRealAereo != null,
      facturadoMaritimo: e.shippingCostRealMaritimo != null,
      landedUsd: calc.landedUsd,
      mercanciaUsd: calc.productCostUsd,
      conCostoReal: e.items.filter(i => i.costRealUsd != null).length,
      lineas: e.items.length,
      // Un piso, no el costo: sin caja pesada, sin el total que facturó el proveedor que
      // despacha por su cuenta (esas piezas viajarían gratis en la cuenta), o con alguna
      // línea sin peso. Cualquiera de las tres hace que lo que se muestra sea un mínimo.
      incompleto: !calc.caja.medido || calc.tramo?.faltaCosto === true || calc.lines.some(l => l.missingWeight),
    })
  }

  return out
}

export interface GastoPorVenir {
  envioId: number
  nombre: string | null
  fletePorPagarUsd: number
  proveedorPorPagarUsd: number
  totalUsd: number
  /** Algún tramo por pagar no tiene factura guardada: su parte es el estimado de tabla. */
  fleteEstimado: boolean
  /** El flete es un estimado de piso o al proveedor le faltan costos cargados: puede ser más. */
  incompleto: boolean
}

// Plata que todavía va a salir por las cajas en curso: el flete de cada tramo que no se pagó
// (el facturado donde se cargó, el estimado donde no) y lo que se le deba al proveedor. Es una
// proyección, no una deuda: sirve para saber cuánto del saldo ya está comprometido.
// Una caja en borrador no entra: es un plan hasta que se confirma (igual que en cuentasPorPagar).
export async function gastosPorVenir(): Promise<{ cajas: GastoPorVenir[]; sobrepagadas: EnvioPendiente[] }> {
  const [costos, pagos, cuentas] = await Promise.all([
    costearEnvios(),
    db.movimiento.groupBy({
      by: ['envioId', 'categoria'],
      where: { tipo: 'egreso', envioId: { not: null }, categoria: { in: [...CATEGORIAS_FLETE] } },
      _sum: { monto: true },
    }),
    cuentasPorPagar(),
  ])
  const pagado = (envioId: number, categoria: string) =>
    dec(pagos.find(p => p.envioId === envioId && p.categoria === categoria)?._sum.monto) ?? 0
  const proveedor = new Map(cuentas.pendientes.map(p => [p.envioId, p]))

  const ids = new Set([...[...costos].filter(([, c]) => !c.borrador).map(([id]) => id), ...proveedor.keys()])
  const cajas = [...ids]
    .map((id): GastoPorVenir => {
      const c = costos.get(id)
      const p = proveedor.get(id)
      const tramos = {
        fleteAereoUsd: c?.fleteAereoUsd ?? 0, pagadoAereoUsd: pagado(id, 'flete_aereo'),
        fleteMaritimoUsd: c?.fleteMaritimoUsd ?? 0, pagadoMaritimoUsd: pagado(id, 'flete_maritimo'),
      }
      const fletePorPagarUsd = porSalirDeCaja({ ...tramos, proveedorUsd: 0 })
      const fleteEstimado = c != null && (
        (!c.facturadoAereo && tramos.fleteAereoUsd - tramos.pagadoAereoUsd > 0.005) ||
        (!c.facturadoMaritimo && tramos.fleteMaritimoUsd - tramos.pagadoMaritimoUsd > 0.005)
      )
      const proveedorPorPagarUsd = Math.max(0, p?.pendiente ?? 0)
      return {
        envioId: id,
        nombre: c?.nombre ?? p?.nombre ?? null,
        fletePorPagarUsd,
        proveedorPorPagarUsd,
        totalUsd: fletePorPagarUsd + proveedorPorPagarUsd,
        fleteEstimado,
        // El piso de la caja (sin pesar, sin medidas) solo afecta a lo estimado: lo facturado es exacto.
        incompleto: (fleteEstimado && (c?.incompleto ?? false)) || (p?.itemsSinCosto ?? 0) > 0,
      }
    })
    .filter(g => g.totalUsd > 0.01)
    .sort((a, b) => b.totalUsd - a.totalUsd)
  return { cajas, sobrepagadas: cuentas.sobrepagadas }
}
