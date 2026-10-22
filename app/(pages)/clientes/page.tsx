import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import { createCliente, deleteCliente } from './actions'
import { VENTA_STATUS, clienteTotales } from '@/lib/clientes'
import { telefonoIntl } from '@/lib/utils'

export const metadata = { title: 'Clientes' }

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ existe?: string; mismoTel?: string; q?: string }>
}) {
  const { existe: yaExistia, mismoTel, q: qRaw } = await searchParams
  const q = qRaw?.trim() ?? ''

  const filas = await db.cliente.findMany({
    where: q ? { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { telefono: { contains: q } }] } : undefined,
    include: {
      // Total de pedidos (incluye presupuestos) para el conteo; los importes salen
      // solo de los confirmados, así que la query se acota a esos y no arrastra los
      // items de cada presupuesto suelto.
      _count: { select: { pedidos: true } },
      pedidos: {
        where: { status: VENTA_STATUS },
        select: { status: true, depositUsd: true, createdAt: true, items: { select: { salePrice: true, quantity: true } } },
      },
    },
  })
  const mismoTelNombre = mismoTel ? filas.find(c => c.id === Number(mismoTel))?.nombre : undefined

  // Primero los que deben (más saldo arriba), después por su último pedido: lo que hay que mirar.
  const clientes = filas
    .map(c => ({
      ...c,
      totales: clienteTotales(c.pedidos),
      ultimo: Math.max(c.createdAt.getTime(), ...c.pedidos.map(p => p.createdAt.getTime())),
    }))
    .sort((a, b) => (b.totales.saldo > 0.005 ? b.totales.saldo : 0) - (a.totales.saldo > 0.005 ? a.totales.saldo : 0) || b.ultimo - a.ultimo)

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

      {mismoTel && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 text-sm text-amber-800">
          Se creó, pero ese teléfono ya era de{' '}
          <Link href={`/clientes/${mismoTel}`} className="font-semibold underline">{mismoTelNombre ?? 'otro cliente'}</Link>.
          Si es la misma persona, borrá el nuevo.
        </div>
      )}

      {/* Nuevo cliente */}
      <FormConResultado
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
        <PendingButton
          className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Agregar
        </PendingButton>
      </FormConResultado>

      <form className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre o teléfono…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <button className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Buscar</button>
        {q && <Link href="/clientes" className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">Limpiar</Link>}
      </form>

      {clientes.length === 0 && q ? (
        <p className="text-sm text-gray-400 py-6 text-center">Ningún cliente coincide con &quot;{q}&quot;.</p>
      ) : clientes.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin clientes todavía</p>
          <p className="text-sm mt-1">Se crean automáticamente al elegir &quot;+ Nuevo cliente&quot; en un presupuesto, o agregalos acá.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {clientes.map(c => {
            const { vendido, saldo, confirmados } = c.totales
            const sinConfirmar = c._count.pedidos - confirmados
            const wa = telefonoIntl(c.telefono)
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
                  {c.telefono && (
                    <p className="text-xs text-gray-400 mt-1">
                      {c.telefono}
                      {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className="ml-2 text-green-600 hover:underline">WhatsApp</a>}
                    </p>
                  )}
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
