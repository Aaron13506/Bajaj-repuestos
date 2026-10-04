import { db } from './db'
import { calcEnvio, type EnvioItemInput, type ProveedorEnvio } from './calc'
import { toConfigMap } from './config'
import { resumirCbm, costoEmbarque } from './cbm'
import { inboundDe } from './inbound'
import { modoDeEnvio } from './modo'
import { expandCostPieces, lookupDeConjuntos, repartirCostoReal, type ProductCost } from './envio-build'
import type { BundlePiece } from './bundle'

// Lo que la lista de envíos muestra por caja. Se calcula EN VIVO, con el mismo costeo que la
// ficha de cada una (calcEnvio en aéreo, costoEmbarque/resumirCbm en marítimo).
//
// Antes la lista leía `Envio.shippingCostEst`, una copia guardada a mano con un botón que
// solo existía en la ficha aérea: el marítimo nunca la escribía, y en el aéreo quedaba vieja
// apenas se cargaba un peso, un precio real o se movía una tasa. Un número que hay que
// acordarse de refrescar es un número que miente; el costo se deriva, no se guarda.
export interface CostoEnvio {
  /** Lo que cuesta MOVER la caja: tramos + marítimo + FOB (el facturado donde ya se cargó). */
  fleteUsd: number
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

// Solo se costean las cajas VIVAS. Las ya cerradas (un marítimo recibido, o un aéreo con todas
// sus líneas entregadas) no cambian y dejaron de decidir nada: costearlas en cada render de
// /envios traía todos sus ítems, líneas y piezas de conjuntos, y eso crece sin techo con el
// historial. Su costo sigue a la vista en la ficha de la caja, que las costea una por una.
export async function costearEnvios(): Promise<Map<number, CostoEnvio>> {
  const [envios, cfgRows, precios] = await Promise.all([
    db.envio.findMany({
      where: {
        NOT: [
          { modo: 'maritimo_cbm', estado: 'entregado' },
          { items: { some: {}, every: { shippingStatus: 'entregado' } } },
        ],
      },
      include: {
        items: {
          select: {
            productId: true, pedidoId: true, quantity: true, bundleItems: true, costRealUsd: true,
            origen: true, inbound: true, isLanded: true, supplierId: true,
            product: {
              select: {
                id: true, nameEs: true, bajajCode: true,
                weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
              },
            },
          },
        },
        lineas: {
          select: {
            id: true, productId: true, quantity: true,
            product: {
              select: {
                id: true, nameEs: true, bajajCode: true,
                weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
              },
            },
          },
        },
        supplier: { select: { id: true, name: true, fobUsd: true } },
      },
    }),
    db.config.findMany(),
    db.supplierPrice.findMany({ select: { productId: true, supplierId: true, priceUsd: true, isLanded: true } }),
  ])

  const cfg = toConfigMap(cfgRows)
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  const lookup = await lookupDeConjuntos(envios.flatMap(e => e.items.map(i => i.bundleItems as BundlePiece[] | null)))

  const precioProveedor = new Map(precios.map(p => [`${p.supplierId}:${p.productId}`, parseFloat(p.priceUsd.toString())]))
  const mapaDe = (supplierId: number | null) =>
    new Map(
      precios
        .filter(p => supplierId != null && p.supplierId === supplierId)
        .map(p => [p.productId, { priceUsd: parseFloat(p.priceUsd.toString()), isLanded: p.isLanded }]),
    )

  const out = new Map<number, CostoEnvio>()

  for (const e of envios) {
    const comisionSalienteUsd = dec(e.comisionSalienteUsd)
    const comisionEntranteUsd = dec(e.comisionEntranteUsd)

    if (e.modo === 'maritimo_cbm') {
      const fob = dec(e.supplier?.fobUsd)
      const resumen = resumirCbm(
        e.lineas.map(l => ({
          itemId: l.id, pedidoId: 0, productId: l.productId, quantity: l.quantity,
          salePrice: 0, bundleItems: null, product: l.product as ProductCost,
        })),
        () => undefined,
        cfg,
        { priceMap: mapaDe(e.supplierId), fobUsd: fob },
      )
      const emb = costoEmbarque(resumen.volumeM3, cfg, fob, {
        mercanciaUsd: resumen.costoOrigenUsd,
        comisionSalienteUsd,
        comisionEntranteUsd,
      })
      // Sin volumen no hay caja que cobrar: el mínimo facturable no se aplica a un
      // embarque vacío (mismo corte que la ficha).
      const fleteUsd = resumen.volumeM3 > 0 ? emb.totalUsd : 0
      out.set(e.id, {
        fleteUsd,
        landedUsd: resumen.costoOrigenUsd + fleteUsd + emb.comisionUsd,
        mercanciaUsd: resumen.costoOrigenUsd,
        conCostoReal: 0,
        lineas: e.lineas.length,
        incompleto: e.estado === 'borrador' || resumen.sinMedidas > 0,
      })
      continue
    }

    const piezas = e.items.flatMap(it => {
      const expandidas = expandCostPieces(
        it.product as ProductCost, it.quantity, it.bundleItems as BundlePiece[] | null, lookup,
      )
      const priceUsdDe = (productId: number | null) =>
        it.supplierId != null && productId != null
          ? precioProveedor.get(`${it.supplierId}:${productId}`) ?? null
          : null
      const reales = repartirCostoReal(
        dec(it.costRealUsd),
        expandidas.map(p => (priceUsdDe(p.productId) ?? (p.priceInr ?? 0) / inrUsd) * p.quantity),
      )
      return expandidas.map((p, idx): EnvioItemInput => ({
        pedidoId: it.pedidoId,
        productId: it.productId,
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
      }))
    })

    const proveedor: ProveedorEnvio | null = e.supplier
      ? {
          supplierId: e.supplier.id,
          nombre: e.supplier.name,
          tramoUsd: dec(e.tramoUsd),
          comisionSalienteUsd,
          comisionEntranteUsd,
        }
      : null
    const calc = calcEnvio(piezas, cfg, {
      proveedor,
      modo: modoDeEnvio(e.modo),
      medidas: {
        pesoKg: dec(e.pesoRealKg),
        dimL: e.cajaL, dimA: e.cajaA, dimH: e.cajaH,
      },
      fleteFacturado: {
        aereoUsd: dec(e.shippingCostRealAereo),
        maritimoUsd: dec(e.shippingCostRealMaritimo),
      },
    })
    out.set(e.id, {
      fleteUsd: calc.airUsd + calc.maritimeUsd + calc.fobUsd,
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
