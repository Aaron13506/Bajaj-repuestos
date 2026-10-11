'use client'

import { useState } from 'react'
import { productoPrompt } from '@/lib/prompts'
import { leerFichaProducto, type FichaProductoIA } from '@/lib/producto-ia'

// ─────────────────────────────────────────────────────────────────────────────
// "Llenar con IA" dentro del formulario de producto: para lo que no viene de un catálogo
// (los accesorios), donde no hay scrape que traiga nombres, motos ni medidas. El producto se
// lo indica el usuario a la IA en su propio chat (SKU, nombre en inglés, motos); acá solo se
// copia el prompt y se pega el JSON. La foto la pega él aparte.
//
// Mismo circuito que MedidasIA — copiar el prompt, pegar la respuesta — y nada se guarda
// acá: la ficha solo LLENA los campos del formulario, que se revisan y se guardan con el
// botón de siempre. Así un accesorio es un producto como cualquier otro, con la misma
// validación y el mismo costeo.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Vuelca la ficha en el formulario; devuelve qué llenó y los avisos propios del form. */
  aplicar: (ficha: FichaProductoIA) => { llenados: string[]; avisos: string[] }
}

export default function FichaProductoIA({ aplicar }: Props) {
  const [respuesta, setRespuesta] = useState('')
  const [copiado, setCopiado] = useState(false)
  const [resultado, setResultado] = useState<{ error?: string; llenados?: string[]; avisos?: string[] } | null>(null)

  function copiar() {
    navigator.clipboard.writeText(productoPrompt()).then(() => {
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1500)
    })
  }

  function llenar() {
    const r = leerFichaProducto(respuesta)
    if (!r.ok) {
      setResultado({ error: r.error })
      return
    }
    const { llenados, avisos } = aplicar(r.ficha)
    setResultado({ llenados, avisos: [...r.avisos, ...avisos] })
  }

  return (
    <details className="rounded-lg border border-violet-200 bg-violet-50/40">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-violet-900">
        Llenar con IA — para productos que no vienen de un catálogo
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1">
        <div className="flex items-start justify-between gap-3">
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-gray-600">
            <li>Copiá el prompt y pegalo en tu IA con el SKU, el nombre en inglés, las motos y lo que tengas (link, fotos, precio).</li>
            <li>Pegá su respuesta abajo: llena código, nombres, motos, ₹, peso, medidas y descripción si la hay.</li>
            <li>La foto la pegás vos. Revisá y guardá como siempre.</li>
          </ol>
          <button
            type="button"
            onClick={copiar}
            className="shrink-0 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            {copiado ? '¡Copiado!' : 'Copiar prompt'}
          </button>
        </div>

        <textarea
          value={respuesta}
          onChange={e => setRespuesta(e.target.value)}
          rows={5}
          placeholder="Pegá acá la respuesta de la IA (con el bloque ```json)…"
          className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-violet-500 focus:ring-2 focus:ring-violet-500"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={llenar}
            disabled={!respuesta.trim()}
            className="rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-sm font-medium text-violet-800 hover:bg-violet-50 disabled:opacity-50"
          >
            Llenar el formulario
          </button>
        </div>

        {resultado?.error && <p role="alert" className="text-xs text-red-600">{resultado.error}</p>}
        {resultado?.llenados && (
          <div className="space-y-1 text-xs">
            <p className="text-green-700">
              {resultado.llenados.length
                ? <>Llené: {resultado.llenados.join(', ')}. Revisá y guardá — todavía no se guardó nada.</>
                : 'La respuesta no traía nada para llenar.'}
            </p>
            {resultado.avisos && resultado.avisos.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-amber-700">
                {resultado.avisos.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </details>
  )
}
