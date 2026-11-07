'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import type { ActionResult } from '@/lib/action-result'
import { CUENTAS, CUENTA_LABELS, type Cuenta } from '@/lib/cuentas'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  actual: { desde: string; saldoInicial: number; cuenta: Cuenta | null } | null
}

// Declara (o corrige) el ancla del saldo de caja — ver aperturaCaja en lib/movimientos.ts.
// No es un movimiento del libro: es el número del que se parte para sumar/restar lo real
// que pasa desde esa fecha.
export default function AperturaCajaForm({ action, actual }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline"
      >
        {actual ? 'Editar apertura' : '+ Declarar saldo de apertura'}
      </button>
      {open && (
        <Modal titulo="Saldo de apertura" onClose={() => setOpen(false)} className="w-96">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Saldo de apertura</h2>
            <p className="text-xs text-gray-500">
              Desde esta fecha, el saldo de caja se calcula como este monto más lo real que entre
              y salga por el libro — no queda ningún movimiento falso cargado.
            </p>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Desde</span>
              <CampoFecha
                name="desde" defaultValue={actual?.desde} required
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Saldo (USD)</span>
              <div className="flex items-center">
                <span className="text-sm text-gray-500 mr-1">$</span>
                <input
                  type="number" name="saldoInicial" step="0.01" defaultValue={actual?.saldoInicial ?? ''} required data-autofocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">En qué cuenta estaba</span>
              <select
                name="cuenta" defaultValue={actual?.cuenta ?? ''}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Sin decir (línea aparte)</option>
                {CUENTAS.map(c => <option key={c} value={c}>{CUENTA_LABELS[c]}</option>)}
              </select>
            </label>

            {error && (
              <p role="alert" className="text-xs text-red-600">{error}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Guardando…' : 'Guardar'}
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
