'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import CamposCobro from '@/components/CamposCobro'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  methods: readonly string[]
  /** Pedido a dólar BCV: lo cobrado en Bs se escribe en dólares BCV, lo demás en divisas. */
  modoBcv: boolean
  /** Lo que falta, en las dos monedas (iguales si el pedido no es a BCV). */
  saldo: { bs: number; divisas: number }
  /** Tasa con la que se anotan los Bs de un cobro en bolívares. */
  tasaBs: { valor: number; etiqueta: string }
}

// Botón + panel para anotar un pago de cliente SIN reabrir el form de aprobación (que
// pisa el adelanto entero). Este siempre suma un Movimiento nuevo por el monto exacto
// que entró — ver registrarPagoPedido.
export default function RegistrarPagoClienteForm({ action, methods, modoBcv, saldo, tasaBs }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  if (!open) {
    return (
      <button
        onClick={() => { limpiarError(); setOpen(true) }}
        className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
      >
        + Registrar pago
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setOpen(false)}>
      <form
        onSubmit={enviar}
        onClick={e => e.stopPropagation()}
        className="mt-24 w-80 bg-white rounded-xl shadow-xl border border-gray-200 p-4 space-y-3 text-left"
      >
        <p className="text-sm font-semibold text-gray-900">Registrar pago recibido</p>

        <CamposCobro methods={methods} modoBcv={modoBcv} saldo={saldo} tasaBs={tasaBs} />

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
          <CampoFecha name="fecha" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nota (opcional)</label>
          <input type="text" name="descripcion" placeholder="Liquidación, cuota, etc." className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-600">{error}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button type="submit" disabled={isPending} className="flex-1 bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors">
            {isPending ? 'Guardando…' : 'Registrar'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
