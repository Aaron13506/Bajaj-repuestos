'use client'

import { useState } from 'react'
import Modal from '@/components/Modal'
import PendingButton from '@/components/PendingButton'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { inboundDe } from '@/lib/inbound'
import type { ModoApp } from '@/lib/modo'
import { REENVIOS, type Reenvio } from '@/lib/reenvio'

export interface ProveedorEnvioOption {
  id: number
  name: string
  origen: string
  inbound: string
  fobUsd: number | null
}

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  suppliers: ProveedorEnvioOption[]
  reenvioDefault: Reenvio
}

const MODOS_OPCIONES: { value: ModoApp; icon: string; label: string; placeholder: string }[] = [
  { value: 'aereo', icon: '✈️', label: 'Aéreo', placeholder: 'Ej: Caja #12' },
  { value: 'express', icon: '⚡', label: 'Express', placeholder: 'Ej: Express María' },
  { value: 'maritimo_cbm', icon: '🚢', label: 'Marítimo', placeholder: 'Ej: Embarque mayo' },
]

export default function CrearEnvioModal({ action, suppliers, reenvioDefault }: Props) {
  const [open, setOpen] = useState(false)
  const [modo, setModo] = useState<ModoApp>('aereo')
  const [supplierId, setSupplierId] = useState('')
  const [reenvioAereo, setReenvioAereo] = useState<Reenvio>(reenvioDefault)
  const [reenvioExpress, setReenvioExpress] = useState<Reenvio>('shoppre')

  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  function abrir() {
    limpiarError()
    setModo('aereo')
    setSupplierId('')
    setReenvioAereo(reenvioDefault)
    setReenvioExpress('shoppre')
    setOpen(true)
  }

  function cambiarModo(nuevo: ModoApp) {
    setModo(nuevo)
    if (nuevo === 'express' && supplierId !== '') {
      const sp = suppliers.find(s => String(s.id) === supplierId)
      if (sp && inboundDe(sp.origen, sp.inbound) !== 'shoppre') {
        setSupplierId('')
      }
    }
  }

  const proveedoresVisibles = modo === 'express'
    ? suppliers.filter(sp => inboundDe(sp.origen, sp.inbound) === 'shoppre')
    : suppliers

  const proveedorElegido = supplierId !== ''
    ? suppliers.find(s => String(s.id) === supplierId) ?? null
    : null
  const esCotizado = proveedorElegido != null && inboundDe(proveedorElegido.origen, proveedorElegido.inbound) === 'cotizado'

  const mostrarReenvioAereo = modo === 'aereo' && !esCotizado
  const mostrarRutaExpress = modo === 'express'
  const modoActual = MODOS_OPCIONES.find(m => m.value === modo)!

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shrink-0"
      >
        + Nuevo envío
      </button>

      {open && (
        <Modal titulo="Nuevo envío" onClose={() => setOpen(false)} className="w-[26rem]">
          <form onSubmit={enviar} className="p-5 space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Nuevo envío</h2>

            <fieldset>
              <legend className="block text-xs font-medium text-gray-600 mb-1.5">Tipo de envío</legend>
              <div role="radiogroup" aria-label="Tipo de envío" className="grid grid-cols-3 gap-2">
                {MODOS_OPCIONES.map(op => {
                  const activo = modo === op.value
                  return (
                    <label
                      key={op.value}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium cursor-pointer transition-colors ${
                        activo
                          ? 'border-blue-600 bg-blue-50 text-blue-800 ring-1 ring-blue-600'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="modo"
                        value={op.value}
                        checked={activo}
                        onChange={() => cambiarModo(op.value)}
                        className="sr-only"
                      />
                      <span aria-hidden="true">{op.icon}</span>
                      <span>{op.label}</span>
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Nombre (opcional)</span>
              <input
                type="text"
                name="nombre"
                data-autofocus
                placeholder={modoActual.placeholder}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Proveedor</span>
              <select
                name="supplierId"
                value={supplierId}
                onChange={e => setSupplierId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">99rpm (precio base ₹)</option>
                {proveedoresVisibles.map(sp => {
                  const cotizado = inboundDe(sp.origen, sp.inbound) === 'cotizado'
                  const detalle = modo === 'maritimo_cbm'
                    ? (sp.fobUsd != null ? ` · FOB $${sp.fobUsd.toFixed(0)}` : ' · FOB por defecto')
                    : (cotizado ? ' · despacha directo' : '')
                  return (
                    <option key={sp.id} value={String(sp.id)}>
                      {sp.name}{detalle}
                    </option>
                  )
                })}
              </select>
            </label>

            {mostrarReenvioAereo && (
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">Reenvío</span>
                <select
                  name="reenvio"
                  value={reenvioAereo}
                  onChange={e => setReenvioAereo(e.target.value as Reenvio)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {REENVIOS.map(rv => (
                    <option key={rv.value} value={rv.value}>{rv.label}</option>
                  ))}
                </select>
              </label>
            )}

            {mostrarRutaExpress && (
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">Ruta</span>
                <select
                  name="reenvio"
                  value={reenvioExpress}
                  onChange={e => setReenvioExpress(e.target.value as Reenvio)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="shoppre">Directo a Venezuela (tope $100)</option>
                  <option value="por_kilo">Por USA · DDP + One Way (sin tope)</option>
                </select>
              </label>
            )}

            {error && (
              <p role="alert" className="text-xs text-red-600">{error}</p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancelar
              </button>
              <PendingButton
                disabled={isPending}
                pendingLabel="Creando…"
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                {isPending ? 'Creando…' : 'Crear envío'}
              </PendingButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
