import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import { createSupplier, renameSupplier, deleteSupplier } from './actions'

export default async function SuppliersPage() {
  const suppliers = await db.supplier.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { prices: true } } },
  })

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Proveedores</h1>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        Además de 99rpm (precio base de cada producto), podés agregar otros proveedores
        con su propio precio en rupias por SKU. Elegí el proveedor activo desde el panel
        lateral — mientras esté activo, los precios se calculan con los suyos, y con el
        precio de 99rpm para los SKU que todavía no tengan un precio cargado para él.
      </p>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Nuevo proveedor</h2>
        <form action={createSupplier} className="flex gap-3">
          <input
            name="name"
            required
            placeholder="Ej: Boodmo"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Agregar
          </button>
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
        {suppliers.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg">Sin proveedores todavía</p>
            <p className="text-sm mt-1">Todos los precios usan a 99rpm como base.</p>
          </div>
        ) : (
          suppliers.map(s => (
            <div key={s.id} className="flex items-center gap-3 px-6 py-4">
              <form action={renameSupplier.bind(null, s.id)} className="flex-1 flex items-center gap-3">
                <input
                  name="name"
                  defaultValue={s.name}
                  required
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <span className="text-xs text-gray-400 shrink-0">
                  {s._count.prices} {s._count.prices === 1 ? 'precio' : 'precios'} cargados
                </span>
                <button
                  type="submit"
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium shrink-0"
                >
                  Guardar
                </button>
              </form>
              <Link
                href={`/suppliers/${s.id}/import`}
                className="text-sm text-gray-600 hover:text-gray-900 font-medium shrink-0"
              >
                Importar JSON
              </Link>
              <DeleteButton
                action={deleteSupplier.bind(null, s.id)}
                confirmMessage={`¿Eliminar "${s.name}"? Se borran también todos sus precios cargados.`}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
