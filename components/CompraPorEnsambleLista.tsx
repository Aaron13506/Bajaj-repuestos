import type { CompraPorEnsamble } from '@/lib/compra-99rpm'

// Sin estado ni hooks: la usan el carril aéreo (dentro del botón de pendientes) y el
// embarque marítimo, tanto en el armador (cliente) como con la caja cerrada (server).
//
// La lista de 99rpm en la forma en que se compra: por ensamble, y dentro de cada uno un
// bloque por "Add to cart". Cada pieza cae en un solo bloque, así que lo que ves al lado
// del checkbox es todo lo que lleva esa pieza — no hay que sumar entre bloques.
export default function CompraPorEnsambleLista({ datos }: { datos: CompraPorEnsamble }) {
  return (
    <div className="divide-y divide-gray-100">
      {datos.ensambles.map(e => (
        <div key={e.ensambleId} className="px-6 py-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900">
              {e.nombre}
              {e.modelo && <span className="ml-2 font-normal text-gray-500">{e.modelo}</span>}
              {e.sku && <span className="ml-2 font-mono text-xs font-normal text-gray-400">{e.sku}</span>}
            </h3>
            <span className="font-mono text-xs text-gray-400">
              {e.bloques.length} {e.bloques.length === 1 ? 'pasada' : 'pasadas'} · {e.unidades} u.
            </span>
          </div>
          {e.pedidos.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-400">{e.pedidos.join(' · ')}</p>
          )}

          <div className="mt-2 space-y-2">
            {e.bloques.map(b => (
              <div key={b.qty} className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 flex items-center justify-between text-xs">
                  <span className="font-semibold text-gray-700">
                    Qty <span className="font-mono text-sm text-blue-700">{b.qty}</span>
                    <span className="ml-2 font-normal text-gray-400">→ Add to cart</span>
                  </span>
                  <span className="font-mono text-gray-400">
                    {b.piezas.length} {b.piezas.length === 1 ? 'pieza' : 'piezas'} · {b.unidades} u.
                  </span>
                </div>
                <ul className="divide-y divide-gray-50">
                  {b.piezas.map((p, i) => (
                    <li key={i} className="px-3 py-1.5 flex items-center gap-2 text-sm">
                      <span className="text-gray-300 select-none">☐</span>
                      <span className="font-mono text-xs text-gray-700 w-8 text-right shrink-0">{p.base}×</span>
                      <span className="font-mono text-xs text-gray-500 w-28 shrink-0">{p.sku ?? '—'}</span>
                      <span className="flex-1 text-gray-900 truncate" title={p.name}>{p.name}</span>
                      {p.groupName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">
                          {p.groupName}
                        </span>
                      )}
                      {p.descontinuada && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">
                          NLS
                        </span>
                      )}
                      {b.qty > 1 && (
                        <span className="font-mono text-xs text-gray-400 w-14 text-right shrink-0">= {p.unidades} u.</span>
                      )}
                    </li>
                  ))}
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
        <div className="px-6 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Sin ensamble de origen</h3>
          <p className="text-xs text-gray-400">
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
