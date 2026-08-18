'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Visor del despiece de un ensamble.
//
// El diagrama ES la herramienta de compra: se elige mirando el dibujo, no leyendo la lista
// de nombres. La miniatura de 40px alcanza para reconocer el ensamble en el listado, pero
// no para distinguir qué pieza es cuál — y en los despieces densos (tornillos, retenes,
// arandelas) ni la imagen a tamaño de tarjeta alcanza. De ahí las dos vistas: grande al
// seleccionar el ensamble, y a pantalla completa con zoom cuando hay que mirar de cerca.
// ─────────────────────────────────────────────────────────────────────────────

const NIVELES = [1, 2, 3]
const ZOOM_MAX = NIVELES[NIVELES.length - 1]

interface Props {
  src: string
  nameEs: string
  bajajCode?: string | null
}

export default function VisorEnsamble({ src, nameEs, bajajCode }: Props) {
  const [abierto, setAbierto] = useState(false)
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Punto del diagrama donde se hizo click, en proporción (0–1) de la imagen. Al ampliar se
  // centra la vista ahí: si no, el zoom salta al centro del dibujo y se pierde la pieza que
  // se estaba mirando, que es justamente lo que se quería ver de cerca.
  const foco = useRef({ x: 0.5, y: 0.5 })

  const cerrar = useCallback(() => { setAbierto(false); setZoom(1) }, [])

  // Esc para cerrar y +/− para el zoom: con la imagen a pantalla completa el mouse está
  // sobre el dibujo, no sobre los botones.
  useEffect(() => {
    if (!abierto) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar()
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(ZOOM_MAX, z + 1))
      else if (e.key === '-' || e.key === '_') setZoom(z => Math.max(1, z - 1))
    }
    window.addEventListener('keydown', onKey)
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previo
    }
  }, [abierto, cerrar])

  // Reposicionar el scroll sobre el punto enfocado, después de que el nuevo tamaño ya está
  // pintado (el scrollWidth recién existe cuando la imagen se re-midió).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = foco.current.x * (el.scrollWidth - el.clientWidth)
    el.scrollTop = foco.current.y * (el.scrollHeight - el.clientHeight)
  }, [zoom, abierto])

  function ampliar(e: React.MouseEvent<HTMLImageElement>) {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    foco.current = {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    }
    setZoom(z => (z >= ZOOM_MAX ? 1 : z + 1))
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="group relative block w-full rounded-lg border border-gray-200 bg-white p-2 mb-4 hover:border-cyan-400 transition-colors"
        title="Ver el despiece completo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={nameEs} className="mx-auto max-h-[22rem] w-auto object-contain" />
        <span className="absolute bottom-3 right-3 text-[11px] font-medium px-2 py-1 rounded-md bg-black/55 text-white group-hover:bg-black/75 transition-colors">
          🔍 Ampliar
        </span>
      </button>

      {abierto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col"
          onClick={cerrar}
        >
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 shrink-0 border-b border-white/10"
            onClick={e => e.stopPropagation()}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">{nameEs}</p>
              {bajajCode && <p className="text-xs font-mono text-white/50">{bajajCode}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {NIVELES.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setZoom(n)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                    zoom === n
                      ? 'bg-white text-gray-900 border-white'
                      : 'border-white/25 text-white/70 hover:bg-white/10'
                  }`}
                >
                  {n}×
                </button>
              ))}
              <button
                type="button"
                onClick={cerrar}
                className="px-3 py-1 text-xs font-medium rounded-lg border border-white/25 text-white/80 hover:bg-white/10 transition-colors"
              >
                Cerrar (Esc)
              </button>
            </div>
          </div>

          {/* A 1× la imagen entra completa; ampliada pasa a ser un lienzo que se recorre
              (ancho = zoom × el del contenedor), que es como se lee un despiece: se ubica
              la zona en la vista completa y después se acerca. */}
          <div
            ref={scrollRef}
            className={`flex-1 p-2 ${zoom === 1 ? 'overflow-hidden flex items-center justify-center' : 'overflow-auto'}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={nameEs}
              onClick={ampliar}
              style={zoom === 1 ? undefined : { width: `${zoom * 100}%`, maxWidth: 'none' }}
              className={`bg-white rounded ${
                zoom === 1
                  ? 'max-h-full max-w-full object-contain cursor-zoom-in'
                  : `h-auto ${zoom >= ZOOM_MAX ? 'cursor-zoom-out' : 'cursor-zoom-in'}`
              }`}
            />
          </div>

          <p className="shrink-0 px-4 py-2 text-[11px] text-white/40 text-center">
            Click sobre la pieza para acercar ahí · click afuera para cerrar
          </p>
        </div>
      )}
    </>
  )
}
