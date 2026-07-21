'use client'

import { useState, useRef, useTransition } from 'react'

interface Props {
  action: (formData: FormData) => Promise<void>
  methods: readonly string[]
  /** Monto sugerido (50% del total) al aprobar por primera vez. */
  suggestedDeposit: number
  /** Modo edición: ya es pedido, se editan los valores actuales del adelanto. */
  initialDeposit?: number | null
  initialMethod?: string | null
  initialDate?: string | null
  mode?: 'aprobar' | 'editar'
}

const money = (n: number) => n.toFixed(2)

export default function AprobarPedidoForm({
  action,
  methods,
  suggestedDeposit,
  initialDeposit = null,
  initialMethod = null,
  initialDate = null,
  mode = 'aprobar',
}: Props) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  const today = new Date().toISOString().slice(0, 10)
  const defaultDeposit = initialDeposit ?? suggestedDeposit

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      await action(fd)
      setOpen(false)
    })
  }

  const triggerLabel = mode === 'aprobar' ? 'Confirmar pedido' : 'Editar adelanto'
  const triggerCls =
    mode === 'aprobar'
      ? 'bg-green-600 text-white hover:bg-green-700'
      : 'border border-gray-300 text-gray-700 hover:bg-gray-50'

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${triggerCls}`}
      >
        {triggerLabel}
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={() => setOpen(false)}
    >
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        onClick={e => e.stopPropagation()}
        className="mt-24 w-80 bg-white rounded-xl shadow-xl border border-gray-200 p-4 space-y-3 text-left"
      >
        <p className="text-sm font-semibold text-gray-900">
          {mode === 'aprobar' ? 'Registrar adelanto y confirmar' : 'Editar adelanto'}
        </p>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Adelanto recibido (USD)</label>
          <div className="flex items-center">
            <span className="text-sm text-gray-400 mr-1">$</span>
            <input
              type="number"
              name="depositUsd"
              min={0}
              step="0.01"
              defaultValue={money(defaultDeposit)}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {mode === 'aprobar' && (
            <p className="text-[11px] text-gray-400 mt-1">Sugerido: 50% del total (${money(suggestedDeposit)}). Editable.</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
          <select
            name="paymentMethod"
            defaultValue={initialMethod ?? methods[0]}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {methods.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
          <input
            type="date"
            name="depositAt"
            defaultValue={initialDate ?? today}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending}
            className="flex-1 bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
          >
            {isPending ? 'Guardando…' : mode === 'aprobar' ? 'Confirmar' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50"
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
