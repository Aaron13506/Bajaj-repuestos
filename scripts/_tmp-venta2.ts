import { db } from '../lib/db'
import { registrarVenta } from '../app/(pages)/ventas/actions'
import { resumenCobro } from '../lib/cobro-bcv'
import { escalonBcvVigente } from '../lib/calc'
import { toConfigMap } from '../lib/config'

const BS = 'Pago móvil / Transferencia Bs', EF = 'Efectivo USD'
async function main() {
  const p = await db.product.findFirst({ where: { stock: 0 }, select: { id: true, stock: true } })
  if (!p) throw new Error('sin producto')
  const c = await db.cliente.create({ data: { nombre: 'ZZ prueba dos métodos' } })
  await db.product.update({ where: { id: p.id }, data: { stock: 2 } })
  const creados: number[] = []
  try {
    const esc = escalonBcvVigente(toConfigMap(await db.config.findMany()))
    const r = resumenCobro([{ salePrice: 80, quantity: 1 }], 40, esc)
    const mitadBs = (r.saldoBcv * 100).toFixed(2)
    console.log('escalón', esc, 'total BCV', r.totalBcv, 'mitad en BCV', r.saldoBcv)
    for (const orden of [[EF, BS], [BS, EF]]) {
      const antes = (await db.pedido.aggregate({ _max: { id: true } }))._max.id ?? 0
      const fd = new FormData()
      fd.set('items', JSON.stringify([{ productId: p.id, quantity: 1, salePrice: 80, costoUnitUsd: 50 }]))
      fd.set('clienteId', String(c.id)); fd.set('fecha', '2026-10-15')
      orden.forEach((m, i) => {
        const s = i === 0 ? '' : '2'
        fd.set(`metodoPago${s}`, m)
        if (m === EF) fd.set(`monto${s}`, '40'); else { fd.set(`tasaBs${s}`, '100'); fd.set(`montoBs${s}`, mitadBs) }
      })
      let res: unknown
      try { res = await registrarVenta(fd) } catch (e) { res = (e as Error).message.slice(0, 60) }
      const v = await db.pedido.findFirst({ where: { id: { gt: antes } }, include: { movimientos: true, items: true } })
      if (v) creados.push(v.id)
      const s = v && resumenCobro(v.items.map(i => ({ salePrice: Number(i.salePrice), quantity: i.quantity })), Number(v.depositUsd), Number(v.brechaEscalonPct))
      console.log(orden.join(' + '), '→', res, v ? { dep: String(v.depositUsd), saldoBcv: s!.saldoBcv, saldoReal: s!.saldoReal, movs: v.movimientos.map(m => [m.cuenta, String(m.monto), m.montoBs && String(m.montoBs)]) } : 'NO SE CREÓ')
    }
  } finally {
    await db.movimiento.deleteMany({ where: { pedidoId: { in: creados } } })
    await db.pedido.deleteMany({ where: { id: { in: creados } } })
    await db.cliente.delete({ where: { id: c.id } })
    await db.product.update({ where: { id: p.id }, data: { stock: p.stock } })
    console.log('limpio; stock', p.id, '=', (await db.product.findUnique({ where: { id: p.id } }))!.stock)
  }
}
main().finally(() => db.$disconnect())
