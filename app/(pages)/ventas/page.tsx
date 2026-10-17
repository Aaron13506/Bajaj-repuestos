import { db } from '@/lib/db'
import Link from 'next/link'
import { resumenCobro } from '@/lib/cobro-bcv'
import { margenDePedido, mesDe } from '@/lib/margen'

// Las ventas del depósito, aparte de los presupuestos: lo que ya tenía y se vendió en el momento.
// Por dentro son un Pedido tipo 'venta' (lib/venta-stock.ts); acá no se mezclan con los encargos.
export default async function VentasPage() {
  const ventas = await db.pedido.findMany({
    where: { tipo: 'venta' },
    include: { items: { select: { salePrice: true, quantity: true, costRealUsd: true, shippingStatusAt: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const filas = ventas.map(v => {
    const lineas = v.items.map(it => ({ salePrice: Number(it.salePrice), quantity: it.quantity }))
    const depositUsd = v.depositUsd != null ? Number(v.depositUsd) : 0
    const cobro = resumenCobro(lineas, depositUsd, v.brechaEscalonPct != null ? Number(v.brechaEscalonPct) : null)
    // El mismo margen que /resultados: el costo de cada línea quedó congelado al vender.
    const margen = margenDePedido(v.items.map(it => ({
      ventaUsd: Number(it.salePrice) * it.quantity,
      costoUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null,
      costoReal: true,
      entregada: true,
      entregadaAt: it.shippingStatusAt,
    })))
    return { v, cobro, margen }
  })

  const mes = mesDe(new Date())
  const delMes = filas.filter(f => mesDe(f.v.createdAt) === mes)
  const vendidoMes = delMes.reduce((s, f) => s + f.margen.ventaUsd, 0)
  const margenMes = delMes.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ventas</h1>
          <p className="text-sm text-gray-500 mt-1">Lo que vendiste del depósito, en el momento y sin caja.</p>
        </div>
        <Link
          href="/ventas/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Nueva venta
        </Link>
      </div>

      {delMes.length > 0 && (
        <p className="text-xs text-gray-500 mb-4">
          Este mes: {delMes.length} {delMes.length === 1 ? 'venta' : 'ventas'} · ${vendidoMes.toFixed(2)} vendido ·{' '}
          <span className="font-semibold text-gray-700">${margenMes.toFixed(2)} de margen</span> (dólares reales)
        </p>
      )}

      {filas.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin ventas</p>
          <p className="text-sm mt-1">Cuando vendas algo que ya tenés en el depósito, aparece acá.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filas.map(({ v, cobro, margen }) => (
            <div key={v.id} className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400">#{v.id}</span>
                  <Link href={`/ventas/${v.id}`} className="font-semibold text-gray-900 hover:text-blue-600">
                    {v.clientName}
                  </Link>
                  <span className="text-xs text-gray-400">
                    {v.items.length} {v.items.length === 1 ? 'pieza' : 'piezas'}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {new Date(v.createdAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {v.notas && ` · ${v.notas}`}
                </p>
              </div>
              <div className="flex items-center gap-6">
                <div className="text-right">
                  <p className="text-xs text-gray-400">Margen</p>
                  {/* Nunca es null: una venta no se guarda sin costo (motivoNoVendible). */}
                  <p className="text-sm font-semibold text-gray-700">
                    ${margen.margenUsd!.toFixed(2)}
                    {margen.margenPct != null && <span className="ml-1 text-xs font-normal text-gray-400">{margen.margenPct.toFixed(0)}%</span>}
                  </p>
                </div>
                <div className="text-right">
                  <span className="font-semibold text-gray-900">${cobro.totalBcv.toFixed(2)}</span>
                  {cobro.escalonPct != null && <span className="ml-1 text-[10px] font-semibold text-gray-400">BCV</span>}
                  {cobro.saldoBcv > 0.005 ? (
                    <p className="text-xs text-amber-600">Saldo ${cobro.saldoBcv.toFixed(2)}</p>
                  ) : (
                    <p className="text-xs text-green-600">{cobro.saldoBcv < -0.005 ? `A favor $${(-cobro.saldoBcv).toFixed(2)}` : 'Pagado'}</p>
                  )}
                </div>
                <Link href={`/ventas/${v.id}`} className="text-sm text-blue-600 hover:text-blue-800">
                  Ver
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
