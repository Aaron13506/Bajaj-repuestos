import { db } from '@/lib/db'
import Link from 'next/link'
import { createEnvio } from './actions'

export default async function EnviosPage() {
  const envios = await db.envio.findMany({
    include: { pedidos: { select: { id: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const sinAsignar = await db.pedido.count({ where: { envioId: null } })

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Envíos</h1>
      </div>

      {/* Crear envío */}
      <form
        action={createEnvio}
        className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-[180px]">
          <label className="block text-sm font-medium text-gray-800 mb-1">Nombre del envío</label>
          <input
            type="text"
            name="nombre"
            placeholder="Ej: Caja Julio #1"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="block text-sm font-medium text-gray-800 mb-1">Notas (opcional)</label>
          <input
            type="text"
            name="notas"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          type="submit"
          className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Crear envío
        </button>
      </form>

      <p className="text-xs text-gray-500 mb-3">
        {sinAsignar} {sinAsignar === 1 ? 'presupuesto/pedido' : 'presupuestos/pedidos'} sin asignar a un envío.
      </p>

      {envios.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin envíos</p>
          <p className="text-sm mt-1">Creá un envío y agrupá presupuestos para calcular el costo real de traerlos.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {envios.map(e => (
            <div
              key={e.id}
              className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400">#{e.id}</span>
                  <Link
                    href={`/envios/${e.id}`}
                    className="font-semibold text-gray-900 hover:text-blue-600"
                  >
                    {e.nombre ?? `Envío #${e.id}`}
                  </Link>
                  <span className="text-xs text-gray-400">
                    {e.pedidos.length} {e.pedidos.length === 1 ? 'pedido' : 'pedidos'}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {new Date(e.createdAt).toLocaleDateString('es-VE', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                  {e.notas && ` · ${e.notas}`}
                </p>
              </div>
              <div className="flex items-center gap-4">
                {e.shippingCostEst != null && (
                  <span className="text-xs text-gray-500">
                    Flete est. <span className="font-mono font-semibold text-gray-800">${parseFloat(e.shippingCostEst.toString()).toFixed(2)}</span>
                  </span>
                )}
                <Link href={`/envios/${e.id}`} className="text-sm text-blue-600 hover:text-blue-800">
                  Calcular
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
