import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import { INBOUNDS, inboundDe, inboundMeta } from '@/lib/inbound'
import { createSupplier, renameSupplier, deleteSupplier } from './actions'

export default async function SuppliersPage() {
  const suppliers = await db.supplier.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { prices: true } } },
  })

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Proveedores</h1>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        Además de 99rpm (precio base de cada producto), podés agregar otros proveedores
        con su propio precio en USD por SKU. Desde el catálogo se filtra por proveedor
        (<code className="text-xs">?proveedor=id</code>) para comparar; el proveedor de una
        línea se elige en la ficha del envío.
      </p>

      {/* Los dos ejes se explican por separado a propósito: durante mucho tiempo fueron la
          misma cosa (India ⇒ Shoppre, China ⇒ directo) y confundirlos es lo que hacía que
          un proveedor como Garuda no entrara en el modelo. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Origen · dónde está la mercancía</h2>
          <p className="text-xs text-gray-500">
            Informativo. Antes decidía la ruta, pero el país no alcanza: dos proveedores de
            India pueden entrar a USA por vías distintas.
          </p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
          <h2 className="text-sm font-semibold text-indigo-900 mb-1">Entrada a USA · cómo se cobra el tramo</h2>
          <ul className="text-xs text-indigo-800 space-y-1">
            {INBOUNDS.map(i => (
              <li key={i.value}>
                <span className="font-semibold">{i.icon} {i.label}</span> — {i.hint}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        El <strong>FOB</strong> es lo que cobra por sacar la carga en un embarque marítimo: es
        fijo por embarque y no escala con el volumen. Vacío usa el default global de{' '}
        <a href="/config" className="underline">Configuración</a>.
        {' '}La <strong>comisión de la transferencia</strong> no se configura acá a propósito: no es
        un rasgo del proveedor sino de cada giro, así que se anota en el envío, con el monto
        que efectivamente costó.
      </p>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Nuevo proveedor</h2>
        <form action={createSupplier} className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[10rem]">
            <span className="block text-xs text-gray-500 mb-1">Nombre</span>
            <input
              name="name"
              required
              placeholder="Ej: Boodmo"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </label>
          <label>
            <span className="block text-xs text-gray-500 mb-1">Origen</span>
            <select
              name="origen"
              defaultValue="india"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="india">🇮🇳 India</option>
              <option value="china">🇨🇳 China</option>
            </select>
          </label>
          <label>
            <span className="block text-xs text-gray-500 mb-1">Entrada a USA</span>
            <select
              name="inbound"
              defaultValue="shoppre"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {INBOUNDS.map(i => (
                <option key={i.value} value={i.value}>{i.icon} {i.label}</option>
              ))}
            </select>
          </label>
          <label title="FOB propio en USD por embarque marítimo. Vacío = usa el default global">
            <span className="block text-xs text-gray-500 mb-1">FOB $</span>
            <input
              name="fobUsd"
              type="number"
              min={0}
              step="0.01"
              placeholder="500"
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </label>
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
          suppliers.map(s => {
            // Un proveedor chino queda fijo en 'cotizado' pase lo que pase en la columna:
            // el select muestra lo que el cálculo va a usar, no lo que dice la fila.
            const inbound = inboundDe(s.origen, s.inbound)
            const meta = inboundMeta(inbound)
            return (
              <div key={s.id} className="px-6 py-4">
                <form action={renameSupplier.bind(null, s.id)} className="flex flex-wrap items-end gap-3">
                  <label className="flex-1 min-w-[10rem]">
                    <span className="block text-xs text-gray-400 mb-1">Nombre</span>
                    <input
                      name="name"
                      defaultValue={s.name}
                      required
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </label>
                  <label>
                    <span className="block text-xs text-gray-400 mb-1">Origen</span>
                    <select
                      name="origen"
                      defaultValue={s.origen}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="india">🇮🇳 India</option>
                      <option value="china">🇨🇳 China</option>
                    </select>
                  </label>
                  <label title={meta.hint}>
                    <span className="block text-xs text-gray-400 mb-1">Entrada a USA</span>
                    <select
                      name="inbound"
                      defaultValue={inbound}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {INBOUNDS.map(i => (
                        <option key={i.value} value={i.value}>{i.icon} {i.label}</option>
                      ))}
                    </select>
                  </label>
                  <label title="FOB propio en USD por embarque marítimo. Vacío = usa el default global de Config">
                    <span className="block text-xs text-gray-400 mb-1">FOB $</span>
                    <input
                      name="fobUsd"
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={s.fobUsd != null ? parseFloat(s.fobUsd.toString()) : ''}
                      placeholder="default"
                      className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </label>
                  <button
                    type="submit"
                    className="text-sm text-blue-600 hover:text-blue-800 font-medium px-2 py-1.5 shrink-0"
                  >
                    Guardar
                  </button>
                </form>
                <div className="flex items-center gap-4 mt-2">
                  <span className="text-xs text-gray-400">
                    {s._count.prices} {s._count.prices === 1 ? 'precio' : 'precios'} cargados
                  </span>
                  <span className="text-xs text-gray-400">
                    {meta.icon} {meta.label}
                    {inbound === 'cotizado' && ' · el total del tramo se carga en cada envío'}
                  </span>
                  <div className="flex-1" />
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
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
