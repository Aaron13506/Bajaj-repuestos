'use client'

import { useAccionDirecta } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import type { Via } from '@/lib/express'

// Cambia la vía de un pedido confirmado que todavía no está en caja ni avanzado (ver
// cambiarViaPedido). No recotiza ni toca cobros: solo define si viaja en caja normal o express.
export default function CambiarViaPedido({ action, a }: {
  action: () => Promise<ActionResult>
  /** La vía a la que pasa. */
  a: Via
}) {
  const { pending, error, ejecutar } = useAccionDirecta()
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => ejecutar(action)}
        className="text-xs text-blue-700 underline underline-offset-2 hover:text-blue-900 disabled:opacity-50"
      >
        {pending ? 'Cambiando…' : a === 'express' ? 'Pasar a express' : 'Pasar a normal'}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  )
}
