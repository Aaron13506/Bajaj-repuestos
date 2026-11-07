'use client'

import { useEffect } from 'react'
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
  yaAnotadasLinea = 0,
  marcar,
  cerrar,
}: {
  /** La línea, para el título de la ventana. */
  nombre: string
  cantidad: number
  /** Pieza suelta: unidades ya anotadas como "no la mandó". */
  yaAnotadasLinea?: number
  /** Los SKU de un conjunto. Vacío = pieza suelta (un solo SKU, la línea). */
  piezas: SkuNoVino[]
  marcar: (formData: FormData) => Promise<ActionResult>
  cerrar: () => void
}) {
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
        <button type="button" onClick={cerrar} aria-label="Cerrar" className="min-h-8 min-w-8 rounded text-gray-600 hover:text-gray-900 hover:bg-gray-100"><span aria-hidden="true">✕</span></button>
      </div>
      <p className="text-xs text-orange-900 bg-orange-50 rounded-lg px-3 py-2">
        Poné cuántas unidades de cada SKU no mandó el proveedor (vacío = vino). La caja no las espera al llegar y la línea no se entrega hasta que lleguen o te las reembolse.
      </p>
      <CamposNoVino cantidad={cantidad} piezas={piezas} yaAnotadasLinea={yaAnotadasLinea} />
      <input type="text" name="nota" placeholder="Nota (opcional): qué te dijo el proveedor" className={`${cls} w-full`} />
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
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

export interface SkuNoVino {
  /** etiquetaPieza: «Nombre (CÓDIGO)». */
  etiqueta: string
  /** Unidades por set. */
  quantity: number
  /** Ya anotadas como "no la mandó" (abiertas): no se pueden volver a anotar. */
  yaAnotadas?: number
}

// Una fila por SKU: cuántas unidades de ese código no vinieron. Vacío = vino todo. Los campos se
// llaman `cant::<etiqueta>` (en una pieza suelta, `cant::`), que es lo que lee reportarNoVino.
export function CamposNoVino({ cantidad, piezas, yaAnotadasLinea = 0 }: { cantidad: number; piezas: SkuNoVino[]; yaAnotadasLinea?: number }) {
  const filas = piezas.length > 0
    ? piezas.map(p => ({ clave: p.etiqueta, nombre: p.etiqueta, total: p.quantity * cantidad, ya: p.yaAnotadas ?? 0 }))
    : [{ clave: '', nombre: null as string | null, total: cantidad, ya: yaAnotadasLinea }]
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-xs text-gray-600">
          <th className="text-left font-semibold pb-1">SKU</th>
          <th className="text-right font-semibold pb-1 w-28">No vinieron</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {filas.map(f => {
          const libres = Math.max(0, f.total - f.ya)
          return (
            <tr key={f.clave}>
              <td className="py-1.5 pr-2 text-gray-800">
                {f.nombre ?? 'Esta pieza'}
                {f.ya > 0 && <span className="ml-1 text-xs text-orange-800">({f.ya} ya anotadas)</span>}
              </td>
              <td className="py-1.5 text-right whitespace-nowrap">
                <input
                  type="number" name={`cant::${f.clave}`} min={0} max={libres} step={1} inputMode="numeric"
                  placeholder="0" disabled={libres === 0}
                  aria-label={`Unidades de ${f.nombre ?? 'la pieza'} que no vinieron`}
                  className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-right font-mono disabled:bg-gray-50"
                />
                <span className="ml-1 text-gray-600">de {libres}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
