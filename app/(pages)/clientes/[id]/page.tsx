import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import { updateCliente, deleteCliente } from '../actions'
import { clienteTotales, pedidoTotal } from '@/lib/clientes'

export default async function ClienteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ nombreTomado?: string }>
}) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()
  const nombreTomado = (await searchParams).nombreTomado

  const cliente = await db.cliente.findUnique({
    where: { id },
    include: {
      pedidos: {
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!cliente) notFound()

  // Solo cuentan los pedidos confirmados (ver clienteTotales): un presupuesto sin
  // aprobar no es una venta todavía.
  const { vendido, adelantado, saldo } = clienteTotales(cliente.pedidos)

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-6">
        <Link href="/clientes" className="text-gray-400 hover:text-gray-600 text-sm">Clientes</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-600">{cliente.nombre}</span>
      </div>

      {nombreTomado && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 text-sm text-amber-800">
          Ya hay otro cliente con ese nombre: no se guardó el cambio.
        </div>
      )}

      {/* Datos del cliente */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <form action={updateCliente.bind(null, cliente.id)} className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Nombre</label>
              <input
                name="nombre"
                defaultValue={cliente.nombre}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Teléfono</label>
              <input
                name="telefono"
                defaultValue={cliente.telefono ?? ''}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Notas</label>
              <textarea
                name="notas"
                defaultValue={cliente.notas ?? ''}
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                Guardar
              </button>
            </div>
          </form>
          <DeleteButton
            action={deleteCliente.bind(null, cliente.id)}
            confirmMessage={`¿Eliminar "${cliente.nombre}"? Sus pedidos no se borran, quedan sin cliente asignado.`}
          />
        </div>
      </div>

      {/* Totales */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1">Total vendido</p>
          <p className="text-xl font-bold font-mono text-gray-900">${vendido.toFixed(2)}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">solo pedidos confirmados</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1">Total adelantado</p>
          <p className="text-xl font-bold font-mono text-gray-900">${adelantado.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1">Saldo pendiente</p>
          <p className={`text-xl font-bold font-mono ${saldo > 0.005 ? 'text-amber-600' : 'text-green-600'}`}>
            ${saldo.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Pedidos */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Pedidos ({cliente.pedidos.length})
          </h2>
        </div>
        {cliente.pedidos.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">Este cliente todavía no tiene pedidos.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {cliente.pedidos.map(p => {
              const total = pedidoTotal(p.items)
              const isPresupuesto = p.status === 'presupuesto'
              const depositUsd = p.depositUsd != null ? parseFloat(p.depositUsd.toString()) : null
              // Un presupuesto sin aprobar no tiene saldo: no se vendió nada todavía.
              const saldoPed = !isPresupuesto && depositUsd != null ? total - depositUsd : null
              return (
                <div key={p.id} className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <Link href={`/presupuestos/${p.id}`} className="text-sm font-medium text-gray-900 hover:text-blue-600">
                      #{p.id}
                    </Link>
                    <span className="ml-2 text-xs text-gray-400">
                      {p.items.length} {p.items.length === 1 ? 'pieza' : 'piezas'}
                    </span>
                    <span className={`ml-2 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      isPresupuesto ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {isPresupuesto ? 'Presupuesto' : 'Pedido'}
                    </span>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(p.createdAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="font-semibold text-gray-900">${total.toFixed(2)}</span>
                    {saldoPed != null && saldoPed > 0.005 && (
                      <p className="text-xs text-amber-600">Saldo ${saldoPed.toFixed(2)}</p>
                    )}
                    {saldoPed != null && saldoPed <= 0.005 && <p className="text-xs text-green-600">Pagado</p>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
