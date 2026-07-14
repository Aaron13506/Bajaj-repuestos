import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import { deletePresupuesto } from './actions'

export default async function PresupuestosPage() {
  const todos = await db.pedido.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  })

  const presupuestos = todos.filter(p => p.tipo !== 'propio' && p.status === 'presupuesto')
  const pedidos = todos.filter(p => p.tipo !== 'propio' && p.status === 'pedido')
  const propios = todos.filter(p => p.tipo === 'propio')

  function Row({ p }: { p: (typeof todos)[0] }) {
    const total = p.items.reduce(
      (sum, item) => sum + parseFloat(item.salePrice.toString()) * item.quantity,
      0
    )
    const isPropio = p.tipo === 'propio'
    const isPresupuesto = p.status === 'presupuesto'
    const depositUsd = p.depositUsd != null ? parseFloat(p.depositUsd.toString()) : null
    const saldo = depositUsd != null ? total - depositUsd : null
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-gray-400">#{p.id}</span>
            <Link
              href={`/presupuestos/${p.id}`}
              className="font-semibold text-gray-900 hover:text-blue-600"
            >
              {p.clientName}
            </Link>
            <span className="text-xs text-gray-400">
              {p.items.length} {p.items.length === 1 ? 'pieza' : 'piezas'}
            </span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              isPropio
                ? 'bg-blue-100 text-blue-700'
                : isPresupuesto
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-green-100 text-green-700'
            }`}>
              {isPropio ? 'Stock propio' : isPresupuesto ? 'Presupuesto' : 'Pedido'}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {new Date(p.createdAt).toLocaleDateString('es-VE', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}
            {p.notas && ` · ${p.notas}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <span className="font-semibold text-gray-900">${total.toFixed(2)}</span>
            {saldo != null && saldo > 0.005 && (
              <p className="text-xs text-amber-600">Saldo ${saldo.toFixed(2)}</p>
            )}
            {saldo != null && saldo <= 0.005 && (
              <p className="text-xs text-green-600">Pagado</p>
            )}
          </div>
          <Link href={`/presupuestos/${p.id}`} className="text-sm text-blue-600 hover:text-blue-800">
            Ver
          </Link>
          <DeleteButton
            action={deletePresupuesto.bind(null, p.id)}
            confirmMessage={`¿Eliminar ${isPropio ? 'stock propio' : isPresupuesto ? 'presupuesto' : 'pedido'} de "${p.clientName}"?`}
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Presupuestos y Pedidos</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/presupuestos/new?tipo=propio"
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            + Stock propio
          </Link>
          <Link
            href="/presupuestos/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + Nuevo presupuesto
          </Link>
        </div>
      </div>

      {todos.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin presupuestos</p>
          <p className="text-sm mt-1">Creá tu primer presupuesto para un cliente.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {presupuestos.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Presupuestos abiertos ({presupuestos.length})
              </h2>
              <div className="space-y-3">
                {presupuestos.map(p => <Row key={p.id} p={p} />)}
              </div>
            </div>
          )}

          {pedidos.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Pedidos confirmados ({pedidos.length})
              </h2>
              <div className="space-y-3">
                {pedidos.map(p => <Row key={p.id} p={p} />)}
              </div>
            </div>
          )}

          {propios.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Stock propio ({propios.length})
              </h2>
              <div className="space-y-3">
                {propios.map(p => <Row key={p.id} p={p} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
