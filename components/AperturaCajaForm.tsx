'use client'

import { useState, useTransition } from 'react'

interface Props {
  action: (formData: FormData) => Promise<void>
  actual: { desde: string; saldoInicial: number } | null
}

// Declara (o corrige) el ancla del saldo de caja — ver aperturaCaja en lib/movimientos.ts.
// No es un movimiento del libro: es el número del que se parte para sumar/restar lo real
// que pasa desde esa fecha.
export default function AperturaCajaForm({ action, actual }: Props) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const today = new Date().toISOString().slice(0, 10)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      await action(fd)
      setOpen(false)
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-blue-600 hover:underline"
      >
        {actual ? 'Editar apertura' : '+ Declarar saldo de apertura'}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setOpen(false)}>
      <form
        onSubmit={handleSubmit}
        onClick={e => e.stopPropagation()}
        className="mt-24 w-96 bg-white rounded-xl shadow-xl border border-gray-200 p-4 space-y-3 text-left"
      >
        <p className="text-sm font-semibold text-gray-900">Saldo de apertura</p>
        <p className="text-xs text-gray-500">
          Desde esta fecha, el saldo de caja se calcula como este monto más lo real que entre
          y salga por el libro — no queda ningún movimiento falso cargado.
        </p>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Desde</label>
          <input
            type="date" name="desde" defaultValue={actual?.desde ?? today} required
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Saldo (USD)</label>
          <div className="flex items-center">
            <span className="text-sm text-gray-400 mr-1">$</span>
            <input
              type="number" name="saldoInicial" step="0.01" defaultValue={actual?.saldoInicial ?? ''} required autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button type="submit" disabled={isPending} className="flex-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            {isPending ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
