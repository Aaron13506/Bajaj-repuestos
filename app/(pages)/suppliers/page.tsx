import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import { INBOUNDS, inboundDe, inboundMeta } from '@/lib/inbound'
import { createSupplier, renameSupplier, deleteSupplier } from './actions'
import { motivoProveedorEnUso } from '@/lib/proveedor-en-uso'

export const metadata = { title: 'Proveedores' }

export default async function SuppliersPage() {
  const suppliers = await db.supplier.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { prices: true, envios: true, pedidoItems: true, movimientos: true } } },
  })

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Proveedores</h1>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Nuevo proveedor</h2>
        <FormConResultado action={createSupplier} className="flex flex-wrap items-end gap-3">
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
              aria-describedby="fob-ayuda"
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </label>
          <PendingButton
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Agregar
          </PendingButton>
        </FormConResultado>
        {/* Antes esto vivía solo en el title (hover): ni el teclado ni el teléfono lo veían. */}
        <p id="fob-ayuda" className="text-xs text-gray-500 mt-2">FOB: USD por embarque marítimo. Vacío usa el default de Configuración.</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
        {suppliers.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="text-lg">Sin proveedores todavía</p>
            <p className="text-sm mt-1">Todos los precios usan a 99rpm como base.</p>
          </div>
        ) : (
          suppliers.map(s => {
            // Un proveedor chino queda fijo en 'cotizado' pase lo que pase en la columna:
            // el select muestra lo que el cálculo va a usar, no lo que dice la fila.
            const inbound = inboundDe(s.origen, s.inbound)
            const meta = inboundMeta(inbound)
            // Con cajas, líneas o pagos a su nombre no se borra: ver motivoProveedorEnUso.
            const enUso = motivoProveedorEnUso(s._count)
            return (
              // Cada fila repite "Nombre / Origen / FOB": el grupo dice de qué proveedor son.
              <div key={s.id} role="group" aria-label={s.name} className="px-4 sm:px-6 py-4">
                <FormConResultado action={renameSupplier.bind(null, s.id)} className="flex flex-wrap items-end gap-3">
                  <label className="flex-1 min-w-[10rem]">
                    <span className="block text-xs text-gray-500 mb-1">Nombre</span>
                    <input
                      name="name"
                      defaultValue={s.name}
                      required
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </label>
                  <label>
                    <span className="block text-xs text-gray-500 mb-1">Origen</span>
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
                    <span className="block text-xs text-gray-500 mb-1">Entrada a USA</span>
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
                    <span className="block text-xs text-gray-500 mb-1">FOB $</span>
                    <input
                      name="fobUsd"
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={s.fobUsd != null ? parseFloat(s.fobUsd.toString()) : ''}
                      placeholder="default"
                      aria-describedby="fob-ayuda"
                      className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </label>
                  <PendingButton
                    className="text-sm text-blue-600 hover:text-blue-800 font-medium px-2 py-1.5 shrink-0"
                  >
                    Guardar
                  </PendingButton>
                </FormConResultado>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2">
                  <span className="text-xs text-gray-500">
                    {s._count.prices} {s._count.prices === 1 ? 'precio cargado' : 'precios cargados'}
                  </span>
                  <span className="text-xs text-gray-500">
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
                  {enUso ? (
                    <span className="text-xs text-gray-500 max-w-xs text-right" title={enUso}>
                      🔒 {enUso}
                    </span>
                  ) : (
                    <DeleteButton
                      action={deleteSupplier.bind(null, s.id)}
                      confirmMessage={`¿Eliminar "${s.name}"? Se borran también todos sus precios cargados.`}
                    />
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
