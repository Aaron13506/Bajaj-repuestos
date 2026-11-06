'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  methods: readonly string[]
  titulo: string
  // Lo que falta pagar del tramo: el monto viene prellenado y se puede editar por si difiere.
  montoSugerido: number | null
}

// "Marcar pagado" de un tramo del flete. Crea un egreso en el libro contra la caja; si el
// tramo no tenía factura cargada, el monto pagado pasa a ser también el facturado.
export default function PagarFleteForm({ action, methods, titulo, montoSugerido }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Marcar pagado
      </button>
      {open && (
        <Modal titulo="Pago de flete" onClose={() => setOpen(false)} className="w-80">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Pago de flete · {titulo}</h2>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Monto (USD)</span>
              <div className="flex items-center">
                <span className="text-sm text-gray-500 mr-1">$</span>
                <input
                  type="number" name="monto" min={0.01} step="0.01" required data-autofocus
                  defaultValue={montoSugerido != null && montoSugerido > 0 ? montoSugerido.toFixed(2) : ''}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              {montoSugerido == null && (
                <p className="text-[11px] text-gray-500 mt-1">Sin factura cargada: lo que pagues queda también como facturado.</p>
              )}
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

            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Guardando…' : 'Registrar pago'}
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
