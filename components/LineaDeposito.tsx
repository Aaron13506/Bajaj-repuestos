'use client'

import { useAccionDirecta } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

// Una línea de pedido que se puede servir con lo del depósito, o que ya se sirvió y espera
// entregarse (lib/venta-stock.ts). Se entrega con "Confirmar entrega", como todo lo recibido.
export default function LineaDeposito({
  modo,
  enDeposito,
  servir,
  devolver,
}: {
  modo: 'servible' | 'servida'
  /** Unidades que hay en el depósito (solo para 'servible'). */
  enDeposito?: number
  servir: () => Promise<ActionResult>
  devolver: () => Promise<ActionResult>
}) {
  const { pending, error, ejecutar } = useAccionDirecta()
  const boton = 'text-[11px] px-2 py-0.5 rounded border disabled:opacity-40'

  return (
    <span className="mt-1 flex items-center gap-2 flex-wrap">
      {modo === 'servible' ? (
        <button type="button" disabled={pending} onClick={() => ejecutar(servir)} className={`${boton} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>
          {pending ? 'Sirviendo…' : `Servir del depósito (hay ${enDeposito})`}
        </button>
      ) : (
        <>
          <span className="text-[10px] text-emerald-700">del depósito</span>
          <button type="button" disabled={pending} onClick={() => ejecutar(devolver)} className={`${boton} border-gray-300 text-gray-600 hover:bg-gray-50`}>
            Devolver al depósito
          </button>
        </>
      )}
      {error && <span role="alert" className="text-[11px] text-red-600">{error}</span>}
    </span>
  )
}
