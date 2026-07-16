'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { importProducts } from '@/app/(pages)/products/import/actions'
import type { ImportResult } from '@/app/(pages)/products/import/actions'

const emptyImportResult: ImportResult = { ok: false, created: 0, errors: [] }

const SCHEMA_EXAMPLE = `{
  "group": {
    "nameEs": "Pedal de freno trasero",
    "nameEn": "Rear Brake Pedal",
    "bajajCode": "JR161036",
    "compatibleModels": "Pulsar N250/N160",
    "sourceUrl": "https://...",
    "subgroups": [
      {
        "name": "Fasteners",
        "products": [
          { "nameEs": "Tornillo M6", "bajajCode": "B0101", "priceInr": 12, "weightGrams": 8, "quantity": 2 },
          { "nameEs": "Tuerca M6", "bajajCode": "B0102", "priceInr": 8 }
        ]
      },
      {
        "name": "Spring",
        "products": [
          { "nameEs": "Resorte de retorno", "priceInr": 60, "weightGrams": 25, "dimL": 6, "dimA": 2, "dimH": 2 }
        ]
      }
    ]
  }
}`

const FLAT_EXAMPLE = `[
  { "nameEs": "Pastilla de freno", "priceInr": 450, "weightGrams": 320 },
  { "nameEs": "Cable de embrague", "priceInr": 180, "weightGrams": 90, "dimL": 120, "dimA": 3, "dimH": 1 },
  { "nameEs": "Filtro de aceite", "priceInr": 220 }
]`

const PROMPT_TEMPLATE = `Extraé de esta página el ensamble/grupo con sus piezas y devolvémelo
SOLO como JSON, con esta estructura exacta:

{
  "group": {
    "nameEs": "<nombre del ensamble en español>",   // OBLIGATORIO
    "nameEn": "...", "bajajCode": "...", "compatibleModels": "...", "sourceUrl": "...",
    "subgroups": [
      {
        "name": "<nombre del subgrupo>",             // ej Fasteners, Spring
        "products": [ { ...una pieza... }, ... ]
      }
    ]
  }
}

Cada PIEZA dentro de "products" puede tener (todos opcionales salvo nameEs):
- nameEs            (string, OBLIGATORIO) nombre en español
- nameEn            (string) nombre en inglés / catálogo
- bajajCode         (string) código de la pieza
- compatibleModels  (string) modelos compatibles
- sourceUrl         (string) URL de la página
- priceInr          (número) precio en India en rupias ₹
- weightGrams       (número) peso en GRAMOS
- dimL, dimA, dimH  (número) dimensiones en CM (largo, ancho, alto)
- quantity          (número) cuántas de esa pieza lleva el ensamble (default 1)

NO incluyas "margin" ni "stock" (se manejan internamente; margen fijo 40%).
NO incluyas "price" salvo que quieras forzar un precio de venta en USD.

Reglas:
- Si una pieza NO tiene peso, dimensiones o precio, omití esos campos (no inventes).
- Si no hay subgrupos, podés poner las piezas directo en "group": { ..., "products": [...] }.
- Para varios ensambles usá "groups": [ {...}, {...} ].
- Para piezas sueltas sin ensamble, devolvé directamente un array: [ {pieza}, {pieza} ].
- Devolvé únicamente el JSON, sin texto alrededor.`

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
    >
      {pending ? 'Importando...' : 'Importar productos'}
    </button>
  )
}

export default function ImportProductsForm() {
  const [state, formAction] = useActionState(importProducts, emptyImportResult)
  const [copied, setCopied] = useState<'prompt' | 'schema' | null>(null)

  function copy(text: string, which: 'prompt' | 'schema') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div className="space-y-6">
      {/* Ayuda: prompt + esquema */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Prompt para la IA</h2>
            <button
              onClick={() => copy(PROMPT_TEMPLATE, 'prompt')}
              className="text-xs text-blue-600 hover:underline"
            >
              {copied === 'prompt' ? '¡Copiado!' : 'Copiar'}
            </button>
          </div>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-72 overflow-auto">{PROMPT_TEMPLATE}</pre>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Ejemplo: ensamble + subgrupos</h2>
            <button
              onClick={() => copy(SCHEMA_EXAMPLE, 'schema')}
              className="text-xs text-blue-600 hover:underline"
            >
              {copied === 'schema' ? '¡Copiado!' : 'Copiar'}
            </button>
          </div>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-72 overflow-auto font-mono">{SCHEMA_EXAMPLE}</pre>
          <p className="text-xs text-gray-400 mt-3 mb-1">O piezas sueltas (array plano):</p>
          <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 overflow-auto font-mono">{FLAT_EXAMPLE}</pre>
        </div>
      </div>

      {/* Formulario */}
      <form action={formAction} className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Pegá el JSON (un objeto o un array)
          </label>
          <textarea
            name="json"
            rows={14}
            placeholder={SCHEMA_EXAMPLE}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
          />
          <p className="text-xs text-gray-400 mt-1">
            Soporta un ensamble con subgrupos, varios (<span className="font-mono">groups</span>) o piezas sueltas (array).
            El precio se calcula desde <span className="font-mono">priceInr</span> + peso + margen; si no hay datos queda en <span className="font-mono">$0</span> para completar luego.
          </p>
        </div>
        <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
          <Link href="/products" className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            Volver
          </Link>
          <SubmitButton />
        </div>
      </form>

      {/* Resultado */}
      {state.message && (
        <div className={`rounded-xl border p-4 ${
          state.ok ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
        }`}>
          <p className={`text-sm font-medium ${state.ok ? 'text-green-800' : 'text-yellow-800'}`}>
            {state.message}
          </p>
          {state.errors.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-gray-700">
              {state.errors.map((err, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-red-500 shrink-0">•</span>
                  <span><span className="font-medium">{err.name}</span> — {err.message}</span>
                </li>
              ))}
            </ul>
          )}
          {state.created > 0 && (
            <Link href="/products" className="inline-block mt-3 text-sm text-blue-600 hover:underline">
              Ver productos →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
