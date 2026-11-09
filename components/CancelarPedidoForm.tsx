'use client'

import { useState } from 'react'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import CamposDevolucion from '@/components/CamposDevolucion'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  /** Texto y clases del botón que abre el formulario (por defecto, los de siempre). */
  etiqueta?: React.ReactNode
  claseBoton?: string
  action: (formData: FormData) => Promise<ActionResult>
  clientName: string
  /** Lo que el cliente tiene pagado (reales). */
  depositUsd: number
  /** Cuántas líneas ya se compraron (pasan a stock propio) y cuántas no (salen de su caja). */
  compradas: number
  libres: number
  /** Lo que se propone devolver: todo si no se compró nada, nada si ya se compró algo (ver términos). */
  devolucionSugerida: number
  tasaSugerida: number
}

// Cancelar un pedido confirmado. Es una decisión con plata detrás, así que dice, antes de hacerla,
// qué va a pasar con cada cosa: lo cobrado (devolver o quedarse), lo ya comprado (pasa a stock
// propio con su costo) y lo que no se compró (sale de su caja).
export default function CancelarPedidoForm({
  action, clientName, depositUsd, compradas, libres, devolucionSugerida, tasaSugerida, etiqueta, claseBoton,
}: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className={claseBoton ?? "px-3 py-1.5 rounded-lg text-sm font-medium border border-red-200 text-red-700 hover:bg-red-50 transition-colors"}
      >
        {etiqueta ?? 'Cancelar pedido'}
      </button>
      {open && (
        <Modal titulo="Cancelar pedido" onClose={() => setOpen(false)} className="w-96">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Cancelar el pedido de {clientName}</h2>

            <ul className="text-xs text-gray-600 space-y-1 bg-gray-50 rounded-lg px-3 py-2">
              <li>
                {compradas > 0
                  ? <>🛒 <strong>{compradas}</strong> {compradas === 1 ? 'línea ya comprada pasa' : 'líneas ya compradas pasan'} a <strong>stock propio</strong> con su costo, su caja y su etapa.</>
                  : <>🛒 Nada se compró todavía: no hay costo que recuperar.</>}
              </li>
              {libres > 0 && (
                <li>📦 {libres} {libres === 1 ? 'línea sin comprar sale' : 'líneas sin comprar salen'} de su caja y quedan en el pedido cancelado, como memoria.</li>
              )}
              <li>
                💵 {depositUsd > 0.005
                  ? <>Tiene cobrado <strong>${depositUsd.toFixed(2)}</strong>. Lo que no devuelvas se queda: cuenta en el resultado del mes.</>
                  : <>No tiene nada cobrado.</>}
              </li>
            </ul>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Por qué se cancela</span>
              <textarea
                name="motivo" required rows={2}
                placeholder="Ej: el cliente se arrepintió / ya no lo necesita"
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>

            {depositUsd > 0.005 && (
              <CamposDevolucion sugerido={devolucionSugerida} maximo={depositUsd} tasaSugerida={tasaSugerida} />
            )}

            {compradas > 0 && depositUsd > 0.005 && (
              <p className="text-[11px] text-amber-700">
                Los términos dicen que el adelanto no se reembolsa una vez pedida la pieza al proveedor: por eso se propone no devolver nada.
              </p>
            )}

            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Cancelando…' : 'Cancelar el pedido'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
                Volver
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
