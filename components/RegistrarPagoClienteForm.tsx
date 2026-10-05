'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { cobraEnBolivares } from '@/lib/pagos'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  methods: readonly string[]
  /** Pedido a dólar BCV: lo cobrado en Bs se escribe en dólares BCV, lo demás en divisas. */
  modoBcv: boolean
  /** Lo que falta, en las dos monedas (iguales si el pedido no es a BCV). */
  saldo: { bs: number; divisas: number }
}

// Botón + panel para anotar un pago de cliente SIN reabrir el form de aprobación (que
// pisa el adelanto entero). Este siempre suma un Movimiento nuevo por el monto exacto
// que entró — ver registrarPagoPedido.
export default function RegistrarPagoClienteForm({ action, methods, modoBcv, saldo }: Props) {
  const [open, setOpen] = useState(false)
  const [metodo, setMetodo] = useState<string>(methods[0])
  const enBs = cobraEnBolivares(metodo)
  const unidad = !modoBcv ? 'USD' : enBs ? 'USD a tasa BCV' : 'USD en divisas'
  const saldoMetodo = enBs ? saldo.bs : saldo.divisas
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

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Monto ({unidad})</label>
          <div className="flex items-center">
            <span className="text-sm text-gray-400 mr-1">$</span>
            <input
              type="number" name="monto" min={0.01} step="0.01" required autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {saldoMetodo > 0.005 && (
            <p className="text-[11px] text-gray-400 mt-1">
              Saldo: ${saldoMetodo.toFixed(2)}{modoBcv && (enBs ? ' a tasa BCV (lo pagado en Bs ÷ la tasa BCV de ese día)' : ' en divisas')}
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
          <select name="metodoPago" value={metodo} onChange={e => setMetodo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            {methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

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
