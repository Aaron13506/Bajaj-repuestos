import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import { deletePresupuesto } from './actions'

export default async function PresupuestosPage() {
  const todos = await db.pedido.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  })

  const presupuestos = todos.filter(p => p.status === 'presupuesto')
  const pedidos = todos.filter(p => p.status === 'pedido')

  function Row({ p }: { p: (typeof todos)[0] }) {
    const total = p.items.reduce(
      (sum, item) => sum + parseFloat(item.salePrice.toString()) * item.quantity,
      0
    )
    const isPresupuesto = p.status === 'presupuesto'
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
              isPresupuesto
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-green-100 text-green-700'
            }`}>
              {isPresupuesto ? 'Presupuesto' : 'Pedido'}
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
          <span className="font-semibold text-gray-900">${total.toFixed(2)}</span>
          <Link href={`/presupuestos/${p.id}`} className="text-sm text-blue-600 hover:text-blue-800">
            Ver
          </Link>
          <DeleteButton
            action={deletePresupuesto.bind(null, p.id)}
            confirmMessage={`¿Eliminar ${isPresupuesto ? 'presupuesto' : 'pedido'} de "${p.clientName}"?`}
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Presupuestos y Pedidos</h1>
        <Link
          href="/presupuestos/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Nuevo presupuesto
        </Link>
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
        </div>
      )}
    </div>
  )
}
