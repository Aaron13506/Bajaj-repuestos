'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  methods: readonly string[]
}

// Solo lo que se le paga AL PROVEEDOR. El flete se le paga a otra empresa (Shoppre, la naviera)
// y tiene su propia puerta en la ficha ("Flete real"): anotado acá no aparecía en la caja,
// porque el "pagado" de esta tarjeta solo suma pago a proveedor y comisión.
const CATEGORIAS = [
  { value: 'pago_proveedor', label: 'Pago a proveedor' },
  { value: 'comision_giro', label: 'Comisión de giro' },
] as const

// Anota plata que realmente salió de la cuenta contra esta caja. No toca los campos de
// lo FACTURADO (tramoUsd, comisiones) — esos siguen siendo el form de al lado.
export default function RegistrarPagoProveedorForm({ action, methods }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
      >
        + Registrar pago a proveedor
      </button>
      {open && (
        <Modal titulo="Registrar pago a proveedor" onClose={() => setOpen(false)} className="w-80">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Registrar pago a proveedor</h2>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Concepto</span>
              <select name="categoria" defaultValue={CATEGORIAS[0].value} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                {CATEGORIAS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Monto (USD)</span>
              <div className="flex items-center">
                <span className="text-sm text-gray-500 mr-1">$</span>
                <input
                  type="number" name="monto" min={0.01} step="0.01" required data-autofocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Método de pago</span>
              <select name="metodoPago" defaultValue={methods[0]} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                {methods.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Fecha</span>
              <CampoFecha name="fecha" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Nota (opcional)</span>
              <input type="text" name="descripcion" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </label>

            {error && (
              <p role="alert" className="text-xs text-red-600">{error}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Guardando…' : 'Registrar'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
