'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fechaCourier, metaEstadoTM, type CheckpointTM } from '@/lib/trackingmore'

export type TrackingPasos = {
  /** "local", "USA", "VE". */
  tramo: string
  numero: string
  transportista: string | null
  estado: string | null
  eventos: CheckpointTM[]
  /** Ya formateado en hora de Venezuela (lo arma el servidor). */
  consultado: string | null
  /** Por qué TrackingMore no lo sigue (courier equivocado, número inválido…). */
  error?: string | null
}

// Los pasos de un tracking (o varios), en una ventana encima de la página (no un desplegable
// que la empuja). Se abre desde el bloque de seguimiento de la caja. La ventana va a
// document.body por un portal, para que no herede el layout de donde está el botón.
export default function PasosTracking({
  trackings,
  titulo,
  boton,
  className = 'text-xs text-blue-600 hover:underline',
}: {
  trackings: TrackingPasos[]
  titulo: string
  boton: string
  className?: string
}) {
  const [abierto, setAbierto] = useState(false)
  const cerrar = useCallback(() => setAbierto(false), [])

  useEffect(() => {
    if (!abierto) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar() }
    window.addEventListener('keydown', onKey)
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previo
    }
  }, [abierto, cerrar])

  if (trackings.length === 0) return null

  return (
    <>
      <button type="button" onClick={() => setAbierto(true)} className={className}>
        {boton}
      </button>
      {abierto && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
          onClick={cerrar}
        >
          <div
            role="dialog" aria-modal="true" aria-label={titulo}
            className="my-8 w-full max-w-xl bg-white rounded-xl shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">{titulo}</h2>
              <button type="button" onClick={cerrar} aria-label="Cerrar" className="px-2 text-gray-400 hover:text-gray-700">
                ✕
              </button>
            </div>
            <div className="px-5 py-4 space-y-6">
              {trackings.map(t => <Linea key={`${t.tramo}:${t.numero}`} t={t} />)}
              <p className="text-[10px] text-gray-400">
                Fechas y horas en la hora local del courier, como las reporta TrackingMore.
              </p>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function Linea({ t }: { t: TrackingPasos }) {
  const meta = metaEstadoTM(t.estado)
  return (
    <section>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3">
        <span className="text-[10px] font-semibold uppercase text-gray-400">{t.tramo}</span>
        <span className="font-mono text-sm">{t.numero}</span>
        {t.transportista && <span className="text-xs text-gray-500">{t.transportista}</span>}
        {meta && (
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${meta.color}`}>
            {meta.icon} {meta.label}
          </span>
        )}
      </div>
      {t.error ? (
        <p className="text-xs text-red-600">{t.error} Revisá el número o el courier en la caja.</p>
      ) : t.eventos.length === 0 ? (
        <p className="text-xs text-gray-400">El courier todavía no reportó ningún paso.</p>
      ) : (
        <ol className="relative border-l-2 border-gray-200 ml-1.5 space-y-4">
          {t.eventos.map((e, i) => {
            const m = metaEstadoTM(e.estado)
            return (
              <li key={i} className="pl-5 relative">
                <span
                  className={`absolute -left-[7px] top-1 w-3 h-3 rounded-full ring-2 ring-white ${
                    i === 0 ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                />
                <p className={`text-sm ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
                  {m && <span className="mr-1">{m.icon}</span>}
                  {e.detalle}
                </p>
                <p className="text-xs text-gray-400">
                  {fechaCourier(e.fecha)}
                  {e.lugar && <> · {e.lugar}</>}
                </p>
              </li>
            )
          })}
        </ol>
      )}
      {t.consultado && <p className="mt-3 text-[10px] text-gray-400">Consultado {t.consultado}</p>}
    </section>
  )
}
