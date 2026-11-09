'use client'

import { useState } from 'react'
import type { CompraPorEnsamble } from '@/lib/compra-99rpm'
import { MARCADOR_99RPM, urlCarrito99 } from '@/lib/marcador-99rpm'

// La usan el carril aéreo (pestaña Comprar) y el embarque marítimo, en el armador y con la caja
// cerrada. Las casillas solo ayudan a seguir la lista con 99rpm abierto al lado: no se guardan.
//
// La lista de 99rpm en la forma en que se compra: por ensamble, y dentro de cada uno un
// bloque por "Add to cart". Cada pieza cae en un solo bloque, así que lo que ves al lado
// del checkbox es todo lo que lleva esa pieza — no hay que sumar entre bloques.
export default function CompraPorEnsambleLista({ datos }: { datos: CompraPorEnsamble }) {
  const [tildes, setTildes] = useState<Set<string>>(new Set())
  const tildar = (k: string) => setTildes(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  return (
    <div className="divide-y divide-gray-100">
      {datos.ensambles.length > 0 && (
        <div className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <a href={urlCarrito99(datos)} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center min-h-9 px-4 py-1.5 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            Abrir carrito de 99rpm con la lista<span className="sr-only"> (otra pestaña)</span>
          </a>
          <span className="text-xs text-gray-600 max-w-prose">
            Después, un clic en el marcador{' '}
            {/* Por innerHTML: React 19 bloquea los href javascript:, y un marcador es justo eso. */}
            <span dangerouslySetInnerHTML={{ __html:
              `<a href="${MARCADOR_99RPM}" title="Arrastralo a la barra de marcadores (una sola vez)" class="font-semibold text-blue-700 underline underline-offset-2">Cargar Motokira</a>`,
            }} />{' '}
            agrega lo que falte con la cantidad exacta y te dice qué falta o sobra. Volver a tocarlo verifica, no duplica. Pagar sigue siendo a mano.
          </span>
        </div>
      )}
      {datos.ensambles.map(e => (
        <div key={e.ensambleId} className="px-4 sm:px-6 py-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900">
              {e.nombre}
              {e.modelo && <span className="ml-2 font-normal text-gray-500">{e.modelo}</span>}
              {e.sku && <span className="ml-2 font-mono text-xs font-normal text-gray-500">{e.sku}</span>}
            </h3>
            {e.sourceUrl && (
              <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-700 underline underline-offset-2 hover:no-underline">
                Abrir en 99rpm ↗<span className="sr-only"> (otra pestaña)</span>
              </a>
            )}
          </div>
          {e.pedidos.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-500">{e.pedidos.join(' · ')}</p>
          )}

          <div className="mt-2 space-y-2">
            {e.bloques.map(b => (
              <div key={b.qty} className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 flex flex-wrap items-center justify-between gap-x-3 text-xs">
                  <span className="font-semibold text-gray-700">
                    Qty <span className="font-mono text-sm text-blue-700">{b.qty}</span>
                    <span className="ml-2 font-normal text-gray-500">→ Add to cart</span>
                  </span>
                  <span className="font-mono text-gray-500">
                    {b.piezas.length} {b.piezas.length === 1 ? 'pieza' : 'piezas'} · {b.unidades} u.
                  </span>
                </div>
                <ul className="divide-y divide-gray-50">
                  {b.piezas.map((p, i) => {
                    const k = `${e.ensambleId}:${b.qty}:${p.sku ?? p.name}`
                    const t = tildes.has(k)
                    return (
                      <li key={i} className="px-3 py-1.5 flex flex-wrap items-center gap-2 text-sm">
                        <label className="flex items-center gap-2 flex-1 min-w-60 cursor-pointer">
                          <input type="checkbox" checked={t} onChange={() => tildar(k)} className="size-4 shrink-0 rounded border-gray-300" />
                          <span className="font-mono text-xs text-gray-700 w-8 text-right shrink-0">{p.base}×</span>
                          <span className="font-mono text-xs text-gray-500 w-28 shrink-0">{p.sku ?? '—'}</span>
                          <span className={`flex-1 min-w-0 ${t ? 'line-through text-gray-500' : 'text-gray-900'}`}>{p.name}</span>
                        </label>
                        {p.groupName && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 shrink-0">
                            {p.groupName}
                          </span>
                        )}
                        {p.descontinuada && (
                          <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 shrink-0">
                            NLS
                          </span>
                        )}
                        {b.qty > 1 && (
                          <span className="font-mono text-xs text-gray-500 text-right shrink-0">= {p.unidades} u.</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>

          {e.avisos.map((a, i) => (
            <p key={i} className="mt-1.5 text-xs text-amber-700">⚠ {a}</p>
          ))}
        </div>
      ))}

      {datos.sinEnsamble.length > 0 && (
        <div className="px-4 sm:px-6 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Sin ensamble de origen</h3>
          <p className="text-xs text-gray-500">
            No traen ensamble de origen, así que no hay página de 99rpm a la que entrar: se buscan por código.
          </p>
          <ul className="mt-1.5 space-y-1">
            {datos.sinEnsamble.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-gray-700 w-8 text-right">{s.qty}×</span>
                <span className="font-mono text-xs text-gray-500 w-28">{s.sku ?? '—'}</span>
                <span className="text-gray-900">{s.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
