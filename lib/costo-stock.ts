import { Prisma } from '@prisma/client'
import { db } from './db'
import { margenPorDefecto, toConfigMap, type ConfigMap } from './config'
import { costoStockActual, precioVentaDeposito } from './venta-stock'

export interface CostoYPrecioDeposito {
  costoUnitUsd: number | null
  precioSugeridoUsd: number
  precioCatalogoUsd: number
  ajustadoPorCosto: boolean
}

/**
 * Costo real en depósito (capas FIFO vigentes del kardex, con fallback a Product.landedCostUsd)
 * y precio sugerido con piso automático de margen (sin alterar Product.price del catálogo).
 */
export async function costosEnDepositoDb(
  productIds: number[],
  client: typeof db | Prisma.TransactionClient = db,
  cfg?: ConfigMap,
): Promise<Map<number, CostoYPrecioDeposito>> {
  const ids = [...new Set(productIds.filter(id => Number.isInteger(id) && id > 0))]
  const out = new Map<number, CostoYPrecioDeposito>()
  if (ids.length === 0) return out

  const [productos, cfgMap] = await Promise.all([
    client.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        stock: true,
        landedCostUsd: true,
        margin: true,
        price: true,
        movimientosStock: {
          where: { cantidad: { gt: 0 } },
          select: { cantidad: true, costoUnitUsd: true, motivo: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      },
    }),
    cfg ? Promise.resolve(cfg) : client.config.findMany().then(toConfigMap),
  ])

  const defaultMargin = margenPorDefecto(cfgMap)
  for (const p of productos) {
    const fallback = p.landedCostUsd != null ? parseFloat(p.landedCostUsd.toString()) : null
    const costoUnitUsd = costoStockActual(
      p.stock,
      p.movimientosStock.map(m => ({
        cantidad: m.cantidad,
        costoUnitUsd: m.costoUnitUsd != null ? parseFloat(m.costoUnitUsd.toString()) : null,
        motivo: m.motivo,
      })),
      fallback,
    )
    const precioCatalogoUsd = parseFloat(p.price.toString())
    const margen = p.margin ?? defaultMargin
    const precio = precioVentaDeposito({ precioCatalogoUsd, costoStockUsd: costoUnitUsd, margen })
    out.set(p.id, {
      costoUnitUsd,
      precioSugeridoUsd: precio.precioSugeridoUsd,
      precioCatalogoUsd,
      ajustadoPorCosto: precio.ajustadoPorCosto,
    })
  }
  return out
}
