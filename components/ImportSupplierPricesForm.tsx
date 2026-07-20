'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { importSupplierPrices } from '@/app/(pages)/suppliers/[id]/import/actions'
import type { SupplierImportResult } from '@/app/(pages)/suppliers/[id]/import/actions'

const emptyResult: SupplierImportResult = { ok: false, updated: 0, skipped: [] }

const ARRAY_EXAMPLE = `[
  { "sku": "JR161036", "priceUsd": 5.20 },
  { "sku": "B0101", "priceUsd": 0.15 }
]`

const MAP_EXAMPLE = `{
  "JR161036": 5.20,
  "B0101": 0.15
}`

const PROMPT_TEMPLATE = `Convertí esta lista de precios de proveedor a JSON, con esta estructura
exacta (array de objetos):

[
  { "sku": "<código Bajaj / SKU>", "priceUsd": <precio en USD, número> },
  ...
]

Reglas:
- El precio va en USD (dólares), sin símbolo, como número.
- Si un ítem no tiene código o precio, omitilo.
- Devolvé únicamente el JSON, sin texto alrededor.`

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
    >
      {pending ? 'Importando...' : 'Importar precios'}
    </button>
  )
}

export default function ImportSupplierPricesForm({ supplierId }: { supplierId: number }) {
  const importForSupplier = importSupplierPrices.bind(null, supplierId)
  const [state, formAction] = useActionState(importForSupplier, emptyResult)
  const [copied, setCopied] = useState<'prompt' | 'array' | 'map' | null>(null)
  const [isLanded, setIsLanded] = useState(false)

  function copy(text: string, which: 'prompt' | 'array' | 'map') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div className="space-y-6">
      {/* Ayuda: prompt + ejemplos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Prompt para la IA</h2>
            <button onClick={() => copy(PROMPT_TEMPLATE, 'prompt')} className="text-xs text-blue-600 hover:underline">
              {copied === 'prompt' ? '¡Copiado!' : 'Copiar'}
            </button>
          </div>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-72 overflow-auto">{PROMPT_TEMPLATE}</pre>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Ejemplo: array</h2>
            <button onClick={() => copy(ARRAY_EXAMPLE, 'array')} className="text-xs text-blue-600 hover:underline">
              {copied === 'array' ? '¡Copiado!' : 'Copiar'}
            </button>
          </div>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 overflow-auto font-mono">{ARRAY_EXAMPLE}</pre>
          <p className="text-xs text-gray-400 mt-3 mb-1">O un mapa plano sku → precio:</p>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 overflow-auto font-mono">{MAP_EXAMPLE}</pre>
        </div>
      </div>

      {/* Formulario */}
      <form action={formAction} className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Pegá el JSON (array u objeto)
          </label>
          <textarea
            name="json"
            rows={12}
            placeholder={ARRAY_EXAMPLE}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
          />
          <p className="text-xs text-gray-400 mt-1">
            El SKU se matchea contra el código Bajaj del catálogo. Los que no coincidan quedan listados abajo.
          </p>
        </div>
        <label className="flex items-start gap-2 cursor-pointer bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
          <input
            type="checkbox"
            name="isLanded"
            value="true"
            checked={isLanded}
            onChange={(e) => setIsLanded(e.target.checked)}
            className="w-4 h-4 mt-0.5 rounded border-gray-300 text-blue-600 accent-blue-600"
          />
          <span className="text-xs text-gray-600">
            Estos precios ya son costo <strong>landed</strong> (puesto en Venezuela, todo incluido) — no sumarles
            Shoppre/seguro/marítimo encima. Dejalo sin marcar si es un costo de origen (equivalente a comprar en India).
          </span>
        </label>
        <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
          <Link href="/suppliers" className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            Volver
          </Link>
          <SubmitButton />
        </div>
      </form>

      {/* Resultado */}
      {state.message && (
        <div className={`rounded-xl border p-4 ${state.ok ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
          <p className={`text-sm font-medium ${state.ok ? 'text-green-800' : 'text-yellow-800'}`}>
            {state.message}
          </p>
          {state.skipped.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-gray-700 max-h-64 overflow-auto">
              {state.skipped.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-red-500 shrink-0">•</span>
                  <span><span className="font-mono">{s.sku}</span> — {s.message}</span>
                </li>
              ))}
            </ul>
          )}
          {state.updated > 0 && (
            <Link href="/products" className="inline-block mt-3 text-sm text-blue-600 hover:underline">
              Ver productos →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
