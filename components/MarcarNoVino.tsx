'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

const cls = 'border border-gray-300 rounded-lg px-2 py-1 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

// "No vino" desde la caja: lo que el proveedor cobró (o va a cobrar) pero no mandó. Es la incidencia
// "sin_enviar" del pedido (lib/incidencias.ts); se resuelve en el pedido como «Llegó» o reembolso.
// Se abre en una ventana (portal a body): metido en la fila, debajo de las piezas del conjunto, no se veía.
export default function MarcarNoVino({
  nombre,
  cantidad,
  piezas,
  marcar,
  cerrar,
}: {
  /** La línea, para el título de la ventana. */
  nombre: string
  cantidad: number
  /** Las piezas de un conjunto (etiquetaPieza), para marcar solo una. Vacío = pieza suelta. */
  piezas: { etiqueta: string; quantity: number }[]
  marcar: (formData: FormData) => Promise<ActionResult>
  cerrar: () => void
}) {
  const [pieza, setPieza] = useState('')
  const { enviar, isPending, error } = useEnviarAccion(marcar, cerrar)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cerrar])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={e => { if (e.target === e.currentTarget) cerrar() }}>
    <form onSubmit={enviar} role="dialog" aria-modal="true" aria-labelledby="no-vino-titulo" className="w-full max-w-md bg-white rounded-xl shadow-xl p-5 my-16 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h2 id="no-vino-titulo" className="text-sm font-semibold text-gray-800">No vino: {nombre}</h2>
        <button type="button" onClick={cerrar} title="Cerrar" className="px-2 text-gray-400 hover:text-gray-700">✕</button>
      </div>
      <p className="text-xs text-orange-900 bg-orange-50 rounded-lg px-3 py-2">
        El proveedor no la mandó todavía: la caja no la espera al llegar y no se entrega hasta que llegue o te la reembolse.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        {piezas.length > 0 && (
          <select name="pieza" value={pieza} onChange={e => setPieza(e.target.value)} className={cls} aria-label="Qué pieza del conjunto">
            <option value="">Conjunto entero</option>
            {piezas.map(p => <option key={p.etiqueta} value={p.etiqueta}>{p.quantity}× {p.etiqueta}</option>)}
          </select>
        )}
        {!pieza && (
          <label className="flex items-center gap-1 text-[11px] text-gray-600">
            {piezas.length > 0 ? 'sets' : 'unidades'}
            <input type="number" name="cantidad" min={1} max={cantidad} defaultValue={cantidad} required className={`${cls} w-16 text-right font-mono`} />
            <span className="text-gray-400">de {cantidad}</span>
          </label>
        )}
      </div>
      <input type="text" name="nota" placeholder="Nota (opcional): qué te dijo el proveedor" className={`${cls} w-full`} />
      {error && <p role="alert" className="text-[11px] text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-40">
          {isPending ? 'Guardando…' : 'Marcar que no vino'}
        </button>
        <button type="button" onClick={cerrar} className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 rounded-lg">Cancelar</button>
      </div>
    </form>
    </div>,
    document.body,
  )
}
