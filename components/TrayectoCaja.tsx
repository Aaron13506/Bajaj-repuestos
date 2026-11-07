'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { TRAMOS_TRACKING, type TramoTracking } from '@/lib/tracking'
import { metaEstado } from '@/lib/ship24'

type TrackingResumen = { tramo: string; courierCode: string | null; estado: string | null; errorSeguimiento: string | null }

const TITULOS: Record<TramoTracking, { titulo: string; sub: string }> = {
  local: { titulo: 'Local en India', sub: 'proveedor → depósito' },
  usa: { titulo: 'Aéreo a USA', sub: 'depósito → Miami' },
  venezuela: { titulo: 'Miami → Caracas', sub: 'courier interno' },
}

// El trayecto de la caja: una tarjeta por tramo con lo que dicen sus trackings, y la tarjeta es
// el botón que elige qué tramo se ve debajo (uno a la vez, no los tres apilados). Arranca en el
// primer tramo sin terminar. El hash (#tramo-usa) lo abre desde un enlace y sobrevive a recargar.
// Los paneles los arma el servidor y quedan montados: cambiar de tramo no pierde lo que se escribía.
export default function TrayectoCaja({ trackings, express, paneles, acciones, children }: {
  trackings: TrackingResumen[]
  express: boolean
  paneles: Partial<Record<TramoTracking, ReactNode>>
  /** A la derecha del título: «Actualizar» de Ship24. */
  acciones?: ReactNode
  /** Avisos de Ship24 (apagado, sin lista de couriers). */
  children?: ReactNode
}) {
  const tramos = TRAMOS_TRACKING.filter(t => !(express && t === 'usa')).map(tramo => {
    const lista = trackings.filter(t => t.tramo === tramo)
    const seguidos = lista.filter(t => t.courierCode)
    const entregados = seguidos.filter(t => t.estado === 'delivered').length
    const conError = seguidos.filter(t => t.errorSeguimiento).length
    const estado: { texto: string; cls: string; listo: boolean } =
      lista.length === 0 ? { texto: 'Sin tracking', cls: 'bg-gray-100 text-gray-700', listo: false }
        : conError > 0 ? { texto: `${conError} no se ${conError === 1 ? 'sigue' : 'siguen'}`, cls: 'bg-red-100 text-red-700', listo: false }
          : seguidos.length === 0 ? { texto: `${lista.length} ${lista.length === 1 ? 'anotado' : 'anotados'}`, cls: 'bg-gray-100 text-gray-700', listo: false }
            : entregados === lista.length ? { texto: 'Entregado', cls: 'bg-green-100 text-green-700', listo: true }
              : lista.length === 1 ? { texto: metaEstado(seguidos[0].estado)?.label ?? 'Por consultar', cls: metaEstado(seguidos[0].estado)?.color ?? 'bg-gray-100 text-gray-700', listo: false }
                : { texto: `${entregados} de ${lista.length} entregados`, cls: 'bg-blue-100 text-blue-700', listo: false }
    const t = express && tramo === 'venezuela' ? { titulo: 'Express a Venezuela', sub: 'Shoppre → Caracas' } : TITULOS[tramo]
    return { tramo, ...t, n: lista.length, estado, auto: seguidos.length > 0 }
  })
  const actual = tramos.findIndex(t => !t.estado.listo)
  const [activo, setActivo] = useState<TramoTracking>(tramos[actual === -1 ? tramos.length - 1 : actual].tramo)
  const refs = useRef<Partial<Record<TramoTracking, HTMLButtonElement | null>>>({})

  const ids = tramos.map(t => t.tramo).join(',')
  useEffect(() => {
    const validos = ids.split(',') as TramoTracking[]
    const sync = () => {
      const h = decodeURIComponent(location.hash.slice(1))
      const t = validos.find(v => h === `tramo-${v}` || (h && document.getElementById(`tramo-${v}`)?.querySelector(`#${CSS.escape(h)}`)))
      if (t) setActivo(t)
    }
    sync()
    addEventListener('hashchange', sync)
    return () => removeEventListener('hashchange', sync)
  }, [ids])

  function abrir(t: TramoTracking, foco = false) {
    setActivo(t)
    history.replaceState(null, '', `#tramo-${t}`)
    if (foco) refs.current[t]?.focus()
  }
  function teclas(e: KeyboardEvent<HTMLButtonElement>) {
    const i = tramos.findIndex(t => t.tramo === activo)
    const n = e.key === 'ArrowRight' ? (i + 1) % tramos.length
      : e.key === 'ArrowLeft' ? (i - 1 + tramos.length) % tramos.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? tramos.length - 1
            : null
    if (n == null) return
    e.preventDefault()
    abrir(tramos[n].tramo, true)
  }

  return (
    <>
      <section aria-labelledby="trayecto-titulo" className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-6 mb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-3">
          <div className="min-w-0">
            <h2 id="trayecto-titulo" className="text-base font-semibold text-gray-900">Trayecto</h2>
            <p className="text-sm text-gray-600">
              Elegí un tramo para ver sus números. Con courier de Ship24 se siguen solos cada hora; sin él quedan anotados.
            </p>
          </div>
          {acciones}
        </div>
        <div role="tablist" aria-label="Tramos del trayecto" className="grid gap-3 grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          {tramos.map((t, i) => {
            const sel = t.tramo === activo
            return (
              <button
                key={t.tramo}
                ref={el => { refs.current[t.tramo] = el }}
                type="button"
                role="tab"
                id={`tab-tramo-${t.tramo}`}
                aria-selected={sel}
                aria-controls={`tramo-${t.tramo}`}
                tabIndex={sel ? 0 : -1}
                onClick={() => abrir(t.tramo)}
                onKeyDown={teclas}
                className={`text-left rounded-lg border px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  sel ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <span className="block text-sm font-semibold text-gray-900">
                  <span className="text-gray-500 font-normal">{i + 1} · </span>{t.titulo}
                </span>
                <span className="block text-xs text-gray-600">
                  {t.sub} · {t.n === 0 ? 'sin números' : `${t.n} ${t.n === 1 ? 'número' : 'números'}`}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${t.estado.cls}`}>{t.estado.texto}</span>
                  {t.n > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-600">
                      {t.auto ? 'automático' : 'a mano'}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        {children && <div className="mt-3 space-y-1">{children}</div>}
      </section>
      {tramos.map(t => (
        <div
          key={t.tramo}
          role="tabpanel"
          id={`tramo-${t.tramo}`}
          aria-labelledby={`tab-tramo-${t.tramo}`}
          hidden={t.tramo !== activo}
        >
          {paneles[t.tramo]}
        </div>
      ))}
    </>
  )
}
