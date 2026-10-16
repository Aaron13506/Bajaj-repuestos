'use client'

import { useAccionDirecta } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

// Vuelve a cotizar un presupuesto vencido: nueva fecha y el escalón BCV de hoy. Los precios no se
// tocan: por eso el aviso manda a mirarlos (Editar) antes de confirmar.
export default function RenovarPresupuestoButton({ action }: { action: () => Promise<ActionResult> }) {
  const { pending, error, ejecutar } = useAccionDirecta()
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => ejecutar(action)}
        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 transition-colors"
      >
        {pending ? 'Renovando…' : 'Renovar presupuesto'}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  )
}
