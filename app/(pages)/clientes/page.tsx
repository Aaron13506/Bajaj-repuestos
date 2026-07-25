import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import { createCliente, deleteCliente } from './actions'
import { VENTA_STATUS, clienteTotales } from '@/lib/clientes'

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ existe?: string }>
}) {
  const yaExistia = (await searchParams).existe

  const clientes = await db.cliente.findMany({
    orderBy: { nombre: 'asc' },
    include: {
      // Total de pedidos (incluye presupuestos) para el conteo; los importes salen
      // solo de los confirmados, así que la query se acota a esos y no arrastra los
      // items de cada presupuesto suelto.
      _count: { select: { pedidos: true } },
      pedidos: {
        where: { status: VENTA_STATUS },
        select: { status: true, depositUsd: true, items: { select: { salePrice: true, quantity: true } } },
      },
    },
  })

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Clientes</h1>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        Cada cliente agrupa todos sus presupuestos y pedidos, para ver de un vistazo
        cuánto compró en total y cuánto le queda pendiente, sin importar en qué envío
        haya viajado cada cosa. Los importes cuentan solo pedidos confirmados.
      </p>

      {yaExistia && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 text-sm text-amber-800">
          Ya había un cliente con ese nombre, no se creó uno nuevo.{' '}
          <Link href={`/clientes/${yaExistia}`} className="font-semibold underline">
            Ver ese cliente
          </Link>
        </div>
      )}

      {/* Nuevo cliente */}
      <form
        action={createCliente}
        className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-[180px]">
          <label className="block text-sm font-medium text-gray-800 mb-1">Nombre</label>
          <input
            type="text"
            name="nombre"
            required
            placeholder="Ej: Andry Marcano"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="block text-sm font-medium text-gray-800 mb-1">Teléfono (opcional)</label>
          <input
            type="text"
            name="telefono"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          type="submit"
          className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Agregar
        </button>
      </form>

      {clientes.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin clientes todavía</p>
          <p className="text-sm mt-1">Se crean automáticamente al elegir &quot;+ Nuevo cliente&quot; en un presupuesto, o agregalos acá.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {clientes.map(c => {
            const { vendido, saldo, confirmados } = clienteTotales(c.pedidos)
            const sinConfirmar = c._count.pedidos - confirmados
            return (
              <div
                key={c.id}
                className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-3">
                    <Link href={`/clientes/${c.id}`} className="font-semibold text-gray-900 hover:text-blue-600">
                      {c.nombre}
                    </Link>
                    <span className="text-xs text-gray-400">
                      {confirmados} {confirmados === 1 ? 'pedido' : 'pedidos'}
                      {sinConfirmar > 0 && ` · ${sinConfirmar} sin aprobar`}
                    </span>
                  </div>
                  {c.telefono && <p className="text-xs text-gray-400 mt-1">{c.telefono}</p>}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="font-semibold text-gray-900">${vendido.toFixed(2)}</span>
                    {saldo > 0.005 && <p className="text-xs text-amber-600">Saldo ${saldo.toFixed(2)}</p>}
                    {saldo <= 0.005 && vendido > 0 && <p className="text-xs text-green-600">Pagado</p>}
                  </div>
                  <Link href={`/clientes/${c.id}`} className="text-sm text-blue-600 hover:text-blue-800">
                    Ver
                  </Link>
                  <DeleteButton
                    action={deleteCliente.bind(null, c.id)}
                    confirmMessage={`¿Eliminar "${c.nombre}"? Sus pedidos no se borran, quedan sin cliente asignado.`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
