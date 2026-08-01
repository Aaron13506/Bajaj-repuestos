'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { updateMeasures, type MeasuresResult } from '@/app/(pages)/products/[id]/measure-actions'

interface Part {
  id: number
  bajajCode: string | null
  nameEs: string
  nameEn: string | null
  models: readonly string[]
  weightGrams: number | null
  quantity: number
}

const emptyResult: MeasuresResult = { ok: false, updated: 0, priced: 0, notFound: [], errors: [] }

const PROMPT_TEMPLATE = `Sos un perito en repuestos de motos. Te paso una lista de piezas (con id,
bajajCode, nombre y "quantity") y necesito el PESO y las DIMENSIONES de envío de cada una, lo más
PRECISO posible, cruzado contra varias fuentes y con la evidencia a la vista.

Voy a AUDITAR tu respuesta a mano: pieza por pieza, fuente por fuente, y voy a abrir los links.
Un dato inventado que se ve prolijo me cuesta plata real en el flete. La única forma de que un
número me sirva es que pueda ver de dónde salió.

Esto NO es un proceso masivo: reviso los productos uno por uno, así que quiero SIEMPRE un
resultado completo y usable para cada pieza, aunque sea una estimación. Nunca dejes una pieza sin
peso/dimensiones ni un campo vacío — si no hay dato directo, estimá por analogía o por geometría
(ver más abajo) y ACLARALO, pero completá la fila igual.

PASO 1 — IDENTIFICÁ LA PIEZA (obligatorio, ANTES de buscar peso):
- Para el 99% de estos códigos Bajaj NO vas a encontrar el SKU exacto con peso publicado en
  ningún lado — eso es normal, no un fracaso de búsqueda. Por eso el primer trabajo NO es
  "buscar el código", es ENTENDER QUÉ PIEZA ES.
- Antes de escribir ninguna query, decidí para cada pieza: qué tipo de componente genérico es
  (ej. "pastilla de freno de tambor trasero", "resorte de retorno de palanca de cambio",
  "buje de reposapiés", "cable de embrague", "reten de horquilla"), su función, el material
  probable (metal/plástico/goma/combinación) y una clase de tamaño aproximada (chico tipo
  tornillo, mediano tipo pastilla/reten, grande tipo amortiguador/basculante).
- Usá el nombre, el código Bajaj y los modelos compatibles solo como PISTAS para llegar a esa
  identificación — no como el objeto de la búsqueda. El modelo de moto (Pulsar, Discover, etc.)
  y la marca (Bajaj) te dicen en qué VEHÍCULO va la pieza, no cuánto pesa: dos piezas del mismo
  tipo genérico pesan casi igual sea cual sea la moto o la marca que las vende.
- Escribí esa identificación en una línea al inicio de la ficha de cada pieza (ver formato más
  abajo) ANTES de los hallazgos. Es lo que voy a auditar primero: si identificaste mal la pieza,
  toda la búsqueda posterior está buscando lo que no es.
- Recién con esa identificación en mano pasás a la investigación: buscás el TIPO de pieza
  (cruzando cualquier marca/modelo que use ese mismo componente), no el código Bajaj a secas.

CANTIDAD (contexto de búsqueda, NO cambia lo que tenés que dar):
- El campo "quantity" (ej. x2 suspensiones, x4 arandelas) es cuántas unidades de esa pieza usa
  ESTE ensamble. Te lo paso solo como contexto — puede ayudarte a entender qué estás viendo si
  una fuente describe la pieza vendida de a pares/kits.
- SIEMPRE quiero el peso y las dimensiones de UNA SOLA unidad (una arandela, un shock, un
  tornillo — nunca el conjunto ni el paquete), sin importar cuánto diga "quantity".
- Si la ÚNICA fuente que encontrás da el peso de un PAQUETE/PAR/KIT (ej. "shock absorber pair:
  3.1 kg" o un listado que vende de a 2), DIVIDÍ por la cantidad de ESA fuente para llegar al
  peso de una unidad, y ACLARALO en la ficha (de qué total partiste y por cuánto dividiste).
- Dimensiones = la caja de UNA SOLA unidad. No apiles ni multipliques nada.

INVESTIGACIÓN — BUSCÁ BIEN, CRUZÁ VARIAS FUENTES:
- El error más común acá es buscar poco y rellenar. No pares en la primera fuente que te da un
  número.
- Partí SIEMPRE de la identificación del PASO 1, no del código Bajaj. Buscá la pieza POR LO QUE
  ES (el tipo genérico), y dejá que aparezcan resultados de cualquier marca/modelo — eso es lo
  que querés, no un problema a filtrar.
- PISO POR PIEZA: al menos 3 fuentes independientes, y al menos 2 de marcas o modelos distintos.
  Si podés traer más, mejor todavía: quiero ver el abanico de valores, no un dato suelto. Un solo
  valor sin nada con qué compararlo no es un dato, es una apuesta.
- VARIÁ los términos de búsqueda; no repitas la misma query. Probá, como mínimo (en este orden
  de prioridad — el genérico primero, el código Bajaj es solo una de varias vías, no la única):
  · el nombre GENÉRICO de la pieza según tu identificación del PASO 1 (\"clutch cable\",
    \"brake pad\", \"fork seal\")
  · el equivalente de otra marca (\"Honda CB160 brake pad weight\")
  · el SKU/código exacto, y también el código sin guiones ni espacios
  · el nombre en inglés del catálogo Bajaj
  · variantes de la métrica: \"part weight\", \"item weight\", \"shipping weight\", \"specifications\",
    \"net weight\", peso en kg y en g
- Fuentes útiles:
  · Catálogos/fichas oficiales Bajaj y del código de parte.
  · Tiendas de repuestos: boodmo.com, 99rpm.com, Amazon, eBay, AliExpress, MercadoLibre.
  · Piezas EQUIVALENTES de CUALQUIER marca y CUALQUIER modelo de moto (mismo tipo de
    repuesto: filtro, pastilla, disco, resorte, tornillo, etc.) — sirven de referencia
    para peso/tamaño.
  · Especificaciones técnicas, manuales de taller, catálogos de aftermarket y foros.
- MUY IMPORTANTE: NO te limites a Bajaj/Pulsar (hay poca data). Ampliá la búsqueda a
  TODAS las marcas: japonesas (Honda, Yamaha, Suzuki, Kawasaki), indias (Bajaj, TVS,
  Hero, Royal Enfield, KTM India), y cualquier otra; de cualquier cilindrada y año. Una
  pastilla, un filtro o un tornillo del mismo tipo pesa y mide casi igual sin importar la
  marca, así que usá esa data para enriquecer y precisar la estimación.
- Mostrame TODOS los valores que encontraste, incluidos los que descartaste y por qué. Si
  difieren, quedate con el más respaldado y explicá el criterio. Un rango amplio (ej. 280-600 g)
  no es un problema: es información, y prefiero verlo a que me lo escondas detrás de un promedio.
- Si no hay dato directo del SKU, estimá por analogía con la pieza equivalente más parecida (de la
  marca que sea) — decilo, y traé igual las fuentes de esa equivalente. Si tampoco hay equivalente
  citable, estimá por GEOMETRÍA: volumen aproximado × densidad del material (ver chequeo físico
  abajo) — es el último recurso, pero siempre hay que llegar a un número.
- Tené en cuenta material y función (metal vs plástico vs goma) para el peso, y el
  tamaño de la CAJA que contendría la pieza para las dimensiones.

QUE LA FUENTE VALGA — FILTRO ANTI-PLACEHOLDER:
- Antes de usar un número, asegurate de que sea el peso REAL de la pieza y no un campo por defecto
  del sitio. Descartá (o marcá como sospechoso) esto:
  · 0,5 kg / 1 kg / 100 g exactos en un listado de marketplace: es el default del formulario.
  · caja 10×10×10, o dimensiones donde L = A = H.
  · peso 0, 0,001, \"N/A\", \"-\", o el campo vacío.
  · el MISMO peso repetido en todas las variantes/SKU de una familia: es autocompletado, no medido.
  · \"shipping weight\" / peso de envío: incluye caja y relleno y suele venir redondeado hacia
    arriba. No es el peso de la pieza. Si es lo único que hay, usalo pero ACLARALO.
- De cada fuente, copiame la FRASE TEXTUAL donde figura el dato (ej. \"Weight: 0.320 kg\") junto al
  link exacto. Si no podés citar la frase textual, esa fuente NO cuenta para el piso de 3.
- No cites una fuente que no abriste. Un link inventado o \"plausible\" es el peor resultado posible:
  peor que no encontrar nada, porque me hace confiar en un número falso.

CHEQUEO FÍSICO OBLIGATORIO (en TODAS las filas, mostrá la cuenta):
- densidad implícita = weightGrams / (dimL × dimA × dimH), en g/cm³.
- Contrastala con el material: acero 7,8 · inox 8,0 · aluminio 2,7 · latón/bronce 8,5 ·
  goma 1,2 · plástico 0,9-1,4 · vidrio 2,5.
- INVARIANTE DURO: la densidad implícita NUNCA puede superar la del material. Si te da más, hay un
  error seguro (casi siempre el peso, o una confusión kg/g). Corregilo y volvé a chequear.
- Que dé BASTANTE menor que el material es normal cuando la pieza no llena la caja (un soporte, un
  cable enrollado, un resorte). Eso está bien — pero decilo en una línea.
- Si te da absurdamente bajo para una pieza maciza (ej. 0,1 g/cm³ en un disco de acero), el peso
  está mal o la caja está inflada. Revisá.

MARGEN:
- Ante la duda, redondeá LEVEMENTE hacia ARRIBA (peso y tamaño): conviene sobreestimar
  un poco para no perder plata en el flete. Margen chico y prudente, NO exagerado.

QUÉ DEVOLVER (en este orden):
1) FICHA POR PIEZA — una por cada pieza QUE TE PASÉ, sin excepción, en este formato compacto y
   escaneable:

   JR161036 — Pastilla de freno trasera (x1)
   identificado como: pastilla de freno de tambor trasero, tipo genérico (metal+ferodo,
              tamaño mediano) — se buscó como "pastilla freno tambor trasero", no solo el
              código Bajaj
   hallazgos: 320 g (boodmo, SKU exacto) · 340 g (Amazon, equivalente Honda) · 310 g (foro) ·
              0,5 kg (AliExpress — DESCARTADO: default de marketplace)
   elegido: 320 g · material: acero+ferodo
   dims: 18 × 6 × 4 cm → densidad 320 / 432 = 0,74 g/cm³ (pastilla no maciza, coherente)
   fuentes:
     - https://… → \"Weight: 0.320 kg\"
     - https://… → \"Item weight: 340 g\"
     - https://… → \"…\"

2) El JSON final, dentro de un bloque de código \`\`\`json … \`\`\`, con TODAS las piezas que te pasé
   (misma cantidad de filas que la lista de entrada, sin faltantes):

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
- weightGrams en gramos = peso de UNA sola unidad; dimL/dimA/dimH en cm = la caja de UNA sola
  unidad. Nunca del conjunto/paquete — ver la sección CANTIDAD.
- TODAS las piezas van con los 4 campos completos (weightGrams, dimL, dimA, dimH). Nada de null,
  nada vacío, ninguna fila faltante: si no hay dato directo, usá el mejor estimado por analogía o
  geometría (ver arriba) — pero siempre completo. Reviso cada pieza a mano, así que prefiero tu
  mejor estimación fundamentada antes que un hueco que después tengo que volver a pedir.
- material y fuentes son para mi auditoría. No incluyas precio ni margen.
- El bloque \`\`\`json debe ser válido y contener únicamente el array (la ficha y las fuentes van
  FUERA del bloque).`

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
  const [state, formAction] = useActionState(updateMeasures, emptyResult)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'prompt' | 'list' | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)

  const missingCount = parts.filter((p) => p.weightGrams == null).length
  const shown = onlyMissing ? parts.filter((p) => p.weightGrams == null) : parts

  // Lo que se le pasa a la IA: identificador + nombre + modelos + cantidad, sin ruido.
  // quantity = cuántas unidades de esa pieza lleva el ensamble (x2 suspensión, x4 arandela);
  // es solo contexto de búsqueda — la IA siempre estima UNA unidad (ver prompt), y eso es
  // exactamente lo que se guarda, sin dividir ni multiplicar nada en el server.
  const listJson = JSON.stringify(
    shown.map((p) => ({
      bajajCode: p.bajajCode,
      id: p.id,
      nameEs: p.nameEs,
      nameEn: p.nameEn,
      models: p.models,
      quantity: p.quantity,
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
