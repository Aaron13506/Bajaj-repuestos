// Product.price es una caché de reprice (landed aéreo / (1 − margen)) y solo se recalculaba al
// tocar medidas o al correr prices:99rpm: con las tasas moviéndose cada hora, el catálogo, la
// búsqueda del armador y el precio por defecto de una venta del depósito mostraban un precio de
// otro día. Lo corre fx:update después de guardar las tasas; escribe solo lo que cambió.
import type { PrismaClient } from '@prisma/client'
import { toConfigMap, margenPorDefecto } from '@/lib/config'
import { reprice } from '@/lib/reprice'

const n = (v: { toString(): string } | null) => (v != null ? parseFloat(v.toString()) : null)

export async function repreciarCatalogo(db: PrismaClient): Promise<{ revisados: number; cambiados: number }> {
  const [cfgRows, productos] = await Promise.all([
    db.config.findMany(),
    db.product.findMany({
      // Sin ₹ o sin peso no hay landed: reprice no tendría nada que escribir.
      where: { priceInr: { not: null }, weightGrams: { not: null } },
      select: {
        id: true, priceInr: true, weightGrams: true, dimL: true, dimA: true, dimH: true,
        margin: true, price: true, priceLocked: true, landedCostUsd: true,
      },
    }),
  ])
  const cfg = toConfigMap(cfgRows)
  const defaultMargin = margenPorDefecto(cfg)

  const cambios: { id: number; data: { margin?: number; landedCostUsd?: number; price?: number } }[] = []
  for (const p of productos) {
    const r = reprice({
      priceInr: n(p.priceInr), weightGrams: p.weightGrams, dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
      margin: p.margin, price: n(p.price) ?? 0, priceLocked: p.priceLocked,
    }, cfg, defaultMargin)
    const mismoPrecio = r.data.price == null || Math.abs(r.data.price - (n(p.price) ?? 0)) < 0.005
    const mismoCosto = r.data.landedCostUsd == null || Math.abs(r.data.landedCostUsd - (n(p.landedCostUsd) ?? -1)) < 0.005
    if (mismoPrecio && mismoCosto) continue
    // El margen no se reescribe acá: es un dato de la pieza (o el global), no algo que mueva la tasa.
    // Con precio fijado a mano sí, porque ahí es lo que se deriva.
    cambios.push({ id: p.id, data: p.priceLocked ? r.data : { landedCostUsd: r.data.landedCostUsd, price: r.data.price } })
  }

  // De a tandas: una transacción por miles de filas bloquearía la tabla demasiado.
  for (let i = 0; i < cambios.length; i += 200) {
    await db.$transaction(cambios.slice(i, i + 200).map(c => db.product.update({ where: { id: c.id }, data: c.data })))
  }
  return { revisados: productos.length, cambiados: cambios.length }
}
