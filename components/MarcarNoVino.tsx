'use client'

// Los campos de "no vino" SKU por SKU que usa el pedido (IncidenciasLinea). En la caja se marca
// desde el buscador por SKU de la pestaña Comprar (CompraEsperas).

const cls = 'border border-gray-300 rounded-lg px-2 py-1 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

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
