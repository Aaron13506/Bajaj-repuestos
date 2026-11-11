'use client'

import { useAccionDirecta } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

// Cambia el reenvío de un pedido por Miami que todavía no tiene líneas en una caja (ver
// cambiarReenvioPedido). No recotiza: solo dice en qué caja aérea va a viajar.
export default function CambiarReenvioPedido({ action, a }: {
  action: () => Promise<ActionResult>
  /** El reenvío al que pasa. */
  a: 'shoppre' | 'por_kilo'
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
        {pending ? 'Cambiando…' : a === 'por_kilo' ? 'Cambiar a por kilo' : 'Cambiar a Shoppre'}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  )
}
