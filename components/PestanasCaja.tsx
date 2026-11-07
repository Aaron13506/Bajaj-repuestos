'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type Pestana = {
  id: string
  label: string
  // Un número que dice cuánto hay por hacer ahí (piezas por comprar, por contar…). Vacío = nada.
  badge?: string | null
  // Otros anclas que viven en este panel aunque no estén en el DOM todavía (#conteo abre el
  // conteo, que se monta recién al abrirse).
  anclas?: string[]
  contenido: ReactNode
}

// Pestañas de la ficha de caja. Los paneles los arma el servidor y se montan todos: cambiar de
// pestaña no vuelve a la red ni pierde lo que se estaba escribiendo en otra. El hash (#comprar)
// las abre desde un enlace — los pasos de la cabecera son enlaces — y sobrevive a una recarga.
export default function PestanasCaja({ pestanas, inicial, etiqueta = 'Secciones de la caja' }: { pestanas: Pestana[]; inicial: string; etiqueta?: string }) {
  const [activa, setActiva] = useState(inicial)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Solo los ids y anclas: los paneles cambian en cada revalidación y no deben re-sincronizar.
  const mapa = JSON.stringify(pestanas.map(p => [p.id, p.anclas ?? []]))
  useEffect(() => {
    const ids = JSON.parse(mapa) as [string, string[]][]
    const sync = () => {
      const h = decodeURIComponent(location.hash.slice(1))
      if (!h) return
      const p = ids.find(([id, anclas]) => id === h || anclas.includes(h))
        ?? ids.find(([id]) => document.getElementById(`panel-${id}`)?.querySelector(`#${CSS.escape(h)}`))
      if (p) setActiva(p[0])
    }
    sync()
    addEventListener('hashchange', sync)
    return () => removeEventListener('hashchange', sync)
  }, [mapa])

  function abrir(id: string, foco = false) {
    setActiva(id)
    history.replaceState(null, '', `#${id}`)
    if (foco) refs.current[id]?.focus()
  }

  function teclas(e: KeyboardEvent<HTMLButtonElement>) {
    const i = pestanas.findIndex(p => p.id === activa)
    const n = e.key === 'ArrowRight' ? (i + 1) % pestanas.length
      : e.key === 'ArrowLeft' ? (i - 1 + pestanas.length) % pestanas.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? pestanas.length - 1
            : null
    if (n == null) return
    e.preventDefault()
    abrir(pestanas[n].id, true)
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label={etiqueta}
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-gray-200 mb-4 -mx-1 px-1"
      >
        {pestanas.map(p => {
          const sel = p.id === activa
          return (
            <button
              key={p.id}
              ref={el => { refs.current[p.id] = el }}
              type="button"
              role="tab"
              id={`tab-${p.id}`}
              aria-selected={sel}
              aria-controls={`panel-${p.id}`}
              tabIndex={sel ? 0 : -1}
              onClick={() => abrir(p.id)}
              onKeyDown={teclas}
              className={`shrink-0 inline-flex items-center gap-2 px-4 py-2.5 -mb-px border-b-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 ${
                sel ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
              }`}
            >
              {p.label}
              {p.badge && (
                <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${sel ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                  {p.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {pestanas.map(p => (
        <div
          key={p.id}
          role="tabpanel"
          id={`panel-${p.id}`}
          aria-labelledby={`tab-${p.id}`}
          hidden={p.id !== activa}
          tabIndex={0}
          className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          {p.contenido}
        </div>
      ))}
    </div>
  )
}
