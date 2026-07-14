'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { updateMeasures, type MeasuresResult } from '@/app/(pages)/products/[id]/measure-actions'

interface Part {
  id: number
  bajajCode: string | null
  nameEs: string
  nameEn: string | null
  compatibleModels: string | null
  weightGrams: number | null
}

const emptyResult: MeasuresResult = { ok: false, updated: 0, priced: 0, notFound: [], errors: [] }

const PROMPT_TEMPLATE = `Sos un perito en repuestos de motos. Te paso una lista de piezas (con id,
bajajCode y nombre) y necesito el PESO y las DIMENSIONES de envío de cada una, lo más
PRECISO posible, corroborado con varias fuentes.

INVESTIGACIÓN (hacela en serio, no adivines):
- Buscá cada pieza en VARIAS fuentes y CRUZÁ los datos antes de decidir. Fuentes útiles:
  · Catálogos/fichas oficiales Bajaj y del código de parte.
  · Tiendas de repuestos: boodmo.com, 99rpm.com, Amazon, eBay, AliExpress, MercadoLibre.
  · Piezas EQUIVALENTES de CUALQUIER marca y CUALQUIER modelo de moto (mismo tipo de
    repuesto: filtro, pastilla, disco, resorte, tornillo, etc.) — sirven de referencia
    para peso/tamaño.
  · Especificaciones técnicas, manuales de taller y foros.
- MUY IMPORTANTE: NO te limites a Bajaj/Pulsar (hay poca data). Ampliá la búsqueda a
  TODAS las marcas: japonesas (Honda, Yamaha, Suzuki, Kawasaki), indias (Bajaj, TVS,
  Hero, Royal Enfield, KTM India), y cualquier otra; de cualquier cilindrada y año. Una
  pastilla, un filtro o un tornillo del mismo tipo pesa y mide casi igual sin importar la
  marca, así que usá TODA esa data para enriquecer y precisar la estimación.
- Corroborá con al MENOS 2-3 fuentes por pieza (mejor de marcas distintas). Si difieren,
  quedate con el valor más respaldado y explicá por qué. Si no hay dato directo, estimá
  por analogía con la pieza equivalente más parecida (de la marca que sea) y decilo.
- Tené en cuenta material y función (metal vs plástico vs goma) para el peso, y el
  tamaño de la CAJA que contendría la pieza para las dimensiones.

MARGEN:
- Ante la duda, redondeá LEVEMENTE hacia ARRIBA (peso y tamaño): conviene sobreestimar
  un poco para no perder plata en el flete. Margen chico y prudente, NO exagerado.

QUÉ DEVOLVER (en este orden):
1) RAZONAMIENTO por pieza: para cada una, 1-3 líneas con cómo llegaste al valor, qué
   fuentes usaste y qué pieza equivalente tomaste de referencia si aplica.
2) FUENTES: lista de los enlaces/fuentes consultados.
3) El JSON final, dentro de un bloque de código \`\`\`json … \`\`\`, con SOLO esto:

\`\`\`json
[
  {
    "bajajCode": "<el código que te di>",   // o "id": <el id que te di>
    "weightGrams": <peso en GRAMOS>,
    "dimL": <largo en CM>,
    "dimA": <ancho en CM>,
    "dimH": <alto en CM>
  }
]
\`\`\`

Reglas del JSON:
- Identificá cada fila con "bajajCode" (o "id") EXACTAMENTE como te lo di. No lo inventes.
- weightGrams en gramos; dimL/dimA/dimH en centímetros (largo, ancho, alto de la caja).
- Si de una pieza solo podés estimar el peso, poné solo "weightGrams" y omití las dims.
- No incluyas precio, margen ni otro campo: solo identificador + medidas.
- El bloque \`\`\`json debe ser válido y contener únicamente el array (el razonamiento y las
  fuentes van FUERA del bloque).`

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
    >
      {pending ? 'Actualizando...' : 'Actualizar medidas'}
    </button>
  )
}

export default function AssemblyMeasures({
  assemblyId,
  parts,
}: {
  assemblyId: number
  parts: Part[]
}) {
  const [state, formAction] = useFormState(updateMeasures, emptyResult)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'prompt' | 'list' | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)

  const missingCount = parts.filter((p) => p.weightGrams == null).length
  const shown = onlyMissing ? parts.filter((p) => p.weightGrams == null) : parts

  // Lo que se le pasa a la IA: identificador + nombre + modelos, sin ruido.
  const listJson = JSON.stringify(
    shown.map((p) => ({
      bajajCode: p.bajajCode,
      id: p.id,
      nameEs: p.nameEs,
      nameEn: p.nameEn,
      compatibleModels: p.compatibleModels,
    })),
    null,
    2,
  )

  function copy(text: string, which: 'prompt' | 'list') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h2 className="font-semibold text-gray-900">Cargar peso y dimensiones</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {missingCount === 0
              ? 'Todas las piezas de este ensamble ya tienen peso.'
              : `${missingCount} de ${parts.length} piezas sin peso. Con IA + JSON.`}
          </p>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-5 space-y-5">
          <p className="text-sm text-gray-500">
            <strong>1)</strong> Copiá la lista de piezas y el prompt, pasáselos a la IA.{' '}
            <strong>2)</strong> Pegá abajo el JSON con las estimaciones. Solo actualiza medidas
            y recalcula el precio de estas piezas; no crea nada.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Lista de piezas para la IA */}
            <div className="bg-gray-50 rounded-lg border border-gray-100 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Piezas</h3>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={onlyMissing}
                      onChange={(e) => setOnlyMissing(e.target.checked)}
                      className="accent-blue-600"
                    />
                    solo sin peso
                  </label>
                  <button onClick={() => copy(listJson, 'list')} className="text-xs text-blue-600 hover:underline">
                    {copied === 'list' ? '¡Copiado!' : 'Copiar'}
                  </button>
                </div>
              </div>
              {shown.length === 0 ? (
                <p className="text-xs text-gray-400 py-2">No hay piezas para mostrar.</p>
              ) : (
                <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-3 max-h-64 overflow-auto font-mono">{listJson}</pre>
              )}
            </div>

            {/* Prompt para la IA */}
            <div className="bg-gray-50 rounded-lg border border-gray-100 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Prompt para la IA</h3>
                <button onClick={() => copy(PROMPT_TEMPLATE, 'prompt')} className="text-xs text-blue-600 hover:underline">
                  {copied === 'prompt' ? '¡Copiado!' : 'Copiar'}
                </button>
              </div>
              <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-3 max-h-64 overflow-auto">{PROMPT_TEMPLATE}</pre>
            </div>
          </div>

          {/* Pegar JSON de vuelta */}
          <form action={formAction} className="space-y-3">
            <input type="hidden" name="assemblyId" value={assemblyId} />
            <label className="block text-sm font-medium text-gray-700">Pegá la respuesta de la IA</label>
            <p className="text-xs text-gray-400 -mt-1">
              Podés pegar la respuesta completa (razonamiento + fuentes + JSON); se extrae el bloque <span className="font-mono">json</span> solo.
            </p>
            <textarea
              name="json"
              rows={8}
              placeholder='Pegá acá la respuesta de la IA (o solo el bloque JSON)'
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
            />
            <div className="flex justify-end">
              <SubmitButton />
            </div>
          </form>

          {/* Resultado */}
          {state.message && (
            <div className={`rounded-lg border p-3 ${
              state.ok ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
            }`}>
              <p className={`text-sm font-medium ${state.ok ? 'text-green-800' : 'text-yellow-800'}`}>
                {state.message}
              </p>
              {state.notFound.length > 0 && (
                <p className="text-xs text-gray-600 font-mono break-words mt-2">
                  No encontrados: {state.notFound.join(', ')}
                </p>
              )}
              {state.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-gray-700">
                  {state.errors.map((err, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-red-500 shrink-0">•</span>
                      <span><span className="font-medium">{err.name}</span> — {err.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
