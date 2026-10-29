'use client'

import { useState } from 'react'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import type { ActionResult } from '@/lib/action-result'
import {
  TRAMOS_TRACKING, TRAMO_TRACKING_META, MAX_TRACKINGS_POR_TRAMO, type TramoTracking, type FilaTracking,
} from '@/lib/tracking'

type Fila = { key: number; numero: string; transportista: string }

// Los trackings de la caja, una lista por tramo con un botón para ir añadiendo renglones. El
// form manda todo junto y la acción reemplaza lo guardado (ver guardarTrackings). La página
// lo monta con una `key` que cambia con lo guardado, así después de guardar arranca de nuevo.
export default function TrackingsCaja({
  action,
  inicial,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  inicial: FilaTracking[]
}) {
  const [siguiente, setSiguiente] = useState(inicial.length + TRAMOS_TRACKING.length)
  const [filas, setFilas] = useState<Record<TramoTracking, Fila[]>>(() => {
    let k = 0
    const porTramo = {} as Record<TramoTracking, Fila[]>
    for (const tramo of TRAMOS_TRACKING) {
      const deTramo = inicial.filter(f => f.tramo === tramo)
      // Un tramo sin nada arranca con un renglón vacío, listo para escribir.
      porTramo[tramo] = deTramo.length > 0
        ? deTramo.map(f => ({ key: k++, numero: f.numero, transportista: f.transportista ?? '' }))
        : [{ key: k++, numero: '', transportista: '' }]
    }
    return porTramo
  })

  function añadir(tramo: TramoTracking) {
    setFilas(prev => ({ ...prev, [tramo]: [...prev[tramo], { key: siguiente, numero: '', transportista: '' }] }))
    setSiguiente(k => k + 1)
  }
  function quitar(tramo: TramoTracking, key: number) {
    setFilas(prev => ({ ...prev, [tramo]: prev[tramo].filter(f => f.key !== key) }))
  }
  function cambiar(tramo: TramoTracking, key: number, campo: 'numero' | 'transportista', valor: string) {
    setFilas(prev => ({ ...prev, [tramo]: prev[tramo].map(f => (f.key === key ? { ...f, [campo]: valor } : f)) }))
  }

  return (
    <FormConResultado action={action} className="mt-5 pt-4 border-t border-gray-100 space-y-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Trackings</h3>
      {TRAMOS_TRACKING.map(tramo => {
        const meta = TRAMO_TRACKING_META[tramo]
        const lista = filas[tramo]
        const lleno = lista.length >= MAX_TRACKINGS_POR_TRAMO
        return (
          <div key={tramo}>
            <p className="text-xs font-medium text-gray-600 mb-1">
              {meta.label}
              {lista.length > 1 && <span className="ml-1 text-gray-400">({lista.length})</span>}
            </p>
            <div className="space-y-1.5">
              {lista.map(f => (
                <div key={f.key} className="flex flex-wrap items-center gap-2">
                  <input
                    type="text" name={`numero_${tramo}`} value={f.numero} placeholder={meta.ejemplo}
                    onChange={e => cambiar(tramo, f.key, 'numero', e.target.value)}
                    aria-label={`Tracking ${meta.corto}`}
                    className="w-48 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="text" name={`transportista_${tramo}`} value={f.transportista} placeholder={meta.transportista}
                    onChange={e => cambiar(tramo, f.key, 'transportista', e.target.value)}
                    aria-label={`Transportista ${meta.corto}`}
                    className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <button
                    type="button" onClick={() => quitar(tramo, f.key)} title="Quitar este tracking"
                    className="px-2 py-1 text-sm text-gray-400 hover:text-red-600 transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {lista.length === 0 && <p className="text-xs text-gray-400">Sin tracking.</p>}
            </div>
            <button
              type="button" onClick={() => añadir(tramo)} disabled={lleno}
              className="mt-1.5 text-xs text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              {lleno ? `Máximo ${MAX_TRACKINGS_POR_TRAMO}` : '+ Añadir tracking'}
            </button>
          </div>
        )
      })}
      <PendingButton className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
        Guardar trackings
      </PendingButton>
    </FormConResultado>
  )
}
