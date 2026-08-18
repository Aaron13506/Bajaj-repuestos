'use client'

import { useActionState, useMemo, useState } from 'react'
import { formatModels, type MotoModelId } from '@/lib/modelo'
import { useFormStatus } from 'react-dom'
import { updateMeasures } from '@/app/(pages)/products/[id]/measure-actions'
import type { MeasuresResult } from '@/lib/measures'
import { MEASURES_PROMPT } from '@/lib/prompts'

// ─────────────────────────────────────────────────────────────────────────────
// Cargador de peso y medidas con IA, trabajado DE A UN ENSAMBLE.
//
// El tamaño de la tanda es la decisión de diseño de este componente. Pieza por pieza es
// insoportable (un presupuesto tiene 30 SKU); todo el presupuesto de una vez satura a la
// IA y la respuesta se degrada justo donde más cuesta auditarla. El ensamble es el punto
// medio natural: son piezas que van juntas, del mismo tamaño y familia, y se investigan
// mejor en contexto.
//
// Peso y dimensiones se piden SIEMPRE juntos, aunque falte uno solo: el dato que ya está
// sirve para contrastar el que devuelve la IA.
// ─────────────────────────────────────────────────────────────────────────────

export interface PiezaMedible {
  id: number
  bajajCode: string | null
  nameEs: string
  nameEn?: string | null
  models?: readonly MotoModelId[]
  quantity: number
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

export interface GrupoMedidas {
  /** Identificador estable del grupo (id de la línea o del ensamble). */
  key: string
  titulo: string
  subtitulo?: string | null
  piezas: PiezaMedible[]
}

interface Props {
  grupos: GrupoMedidas[]
  /** Rutas a revalidar además del catálogo — la pantalla desde la que se está cargando. */
  revalidate?: string
  /** Ficha de ensamble: se revalida esa página puntual. */
  assemblyId?: number
  titulo?: string
  /** Abierto de entrada (útil cuando faltan medidas y sin ellas no hay costo posible). */
  defaultOpen?: boolean
}

const emptyResult: MeasuresResult = { ok: false, updated: 0, priced: 0, notFound: [], errors: [] }

// Qué le falta a la pieza. El volumen es lo que se factura por mar, así que "dims" es
// tan bloqueante como el peso — y en la práctica casi siempre faltan los dos juntos.
function faltante(p: PiezaMedible): 'peso' | 'dims' | 'peso+dims' | null {
  const sinPeso = p.weightGrams == null
  const sinDims = !(p.dimL && p.dimA && p.dimH)
  if (sinPeso && sinDims) return 'peso+dims'
  if (sinPeso) return 'peso'
  if (sinDims) return 'dims'
  return null
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
    >
      {pending ? 'Actualizando...' : 'Cargar medidas'}
    </button>
  )
}

export default function MedidasIA({
  grupos,
  revalidate,
  assemblyId,
  titulo = 'Cargar peso y medidas',
  defaultOpen = false,
}: Props) {
  const [state, formAction] = useActionState(updateMeasures, emptyResult)
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState<'prompt' | 'list' | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [buscar, setBuscar] = useState('')

  // Buscador de PIEZA, no de grupo. Un embarque puede repartirse en sesenta ensambles, y
  // ahí "¿esta pieza que compré está cargada?" no se contesta mirando la fila de pestañas:
  // la pieza aparece dentro de una sola y su nombre no está escrito en ningún chip. Se
  // busca por código o por nombre — que es lo que uno tiene a mano — y quedan a la vista
  // los grupos que la contienen.
  const q = buscar.trim().toLowerCase()
  const coincide = (p: PiezaMedible) =>
    (p.bajajCode ?? '').toLowerCase().includes(q) ||
    p.nameEs.toLowerCase().includes(q) ||
    (p.nameEn ?? '').toLowerCase().includes(q)

  // Cada grupo con su conteo de faltantes, para poder ir tachándolos a medida que se cargan.
  const resumen = useMemo(
    () => grupos.map(g => ({ ...g, faltan: g.piezas.filter(p => faltante(p) != null).length })),
    [grupos],
  )
  const todos = resumen.map(g => ({ ...g, hits: q.length > 0 ? g.piezas.filter(coincide).length : 0 }))
  const conHits = todos.filter(g => g.hits > 0)
  const visibles = q.length > 0 ? conHits : todos
  const totalFaltan = resumen.reduce((s, g) => s + g.faltan, 0)
  const gruposPendientes = resumen.filter(g => g.faltan > 0)
  const totalPiezas = grupos.reduce((s, g) => s + g.piezas.length, 0)

  // Arranca en el primer grupo que tenga algo pendiente: es el que se va a trabajar.
  const [activeKey, setActiveKey] = useState<string>(
    () => gruposPendientes[0]?.key ?? resumen[0]?.key ?? '',
  )
  const elegido = resumen.find(g => g.key === activeKey) ?? resumen[0]
  // Buscando, si el grupo abierto no tiene la pieza se salta al primero que sí la tiene:
  // el resultado tiene que verse sin un segundo clic.
  const activo = q.length > 0 && !conHits.some(g => g.key === elegido?.key)
    ? (conHits[0] ?? elegido)
    : elegido

  // Lo que se le pasa a la IA: identificador + nombre + modelos + cantidad + qué le falta.
  // quantity es solo contexto de búsqueda — la IA siempre estima UNA unidad (ver el prompt),
  // y eso es exactamente lo que se guarda, sin dividir ni multiplicar nada en el server.
  const piezasVisibles = (activo?.piezas ?? []).filter(p => !onlyMissing || faltante(p) != null)
  const listJson = JSON.stringify(
    piezasVisibles.map(p => ({
      bajajCode: p.bajajCode,
      id: p.id,
      nameEs: p.nameEs,
      nameEn: p.nameEn ?? null,
      compatibleModels: p.models?.length ? formatModels(p.models) : null,
      quantity: p.quantity,
      falta: faltante(p) ?? 'nada (revisar)',
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

  if (totalPiezas === 0) return null

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between text-left">
        <div>
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            {titulo}
            {totalFaltan > 0 && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                {totalFaltan} sin medir
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {totalFaltan === 0
              ? `Las ${totalPiezas} piezas ya tienen peso y medidas.`
              : `${gruposPendientes.length} de ${resumen.length} ${resumen.length === 1 ? 'grupo' : 'grupos'} con piezas sin medir. Se trabaja de a un ensamble.`}
          </p>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && activo && (
        <div className="mt-5 space-y-5">
          <p className="text-sm text-gray-500">
            <strong>1)</strong> Elegí un ensamble. <strong>2)</strong> Copiale la lista y el prompt a la IA.{' '}
            <strong>3)</strong> Pegá acá el JSON que devuelve. Solo actualiza medidas y recalcula el
            precio de esas piezas; no crea nada.
          </p>

          {/* Buscar una pieza entre todos los grupos */}
          {resumen.length > 1 && (
            <div>
              <input
                type="text"
                value={buscar}
                onChange={e => setBuscar(e.target.value)}
                placeholder="Buscar una pieza por código o nombre (ej. 52DH1531)…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {q.length > 0 && (
                <p className="text-xs mt-1.5">
                  {conHits.length === 0 ? (
                    <span className="text-amber-700">
                      Ninguna pieza de este embarque coincide con «{buscar.trim()}». Si la compraste, todavía no
                      está guardada en la caja.
                    </span>
                  ) : (
                    <span className="text-gray-500">
                      {conHits.reduce((s, g) => s + g.hits, 0)} coincidencia
                      {conHits.reduce((s, g) => s + g.hits, 0) === 1 ? '' : 's'} en {conHits.length}{' '}
                      {conHits.length === 1 ? 'ensamble' : 'ensambles'}.{' '}
                      <button type="button" onClick={() => setBuscar('')} className="text-blue-600 hover:underline">
                        Ver todos
                      </button>
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Selector de ensamble — la tanda de trabajo */}
          {resumen.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {visibles.map(g => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setActiveKey(g.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    g.key === activo?.key
                      ? 'bg-blue-600 text-white border-blue-600'
                      : g.faltan === 0
                        ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                  title={g.subtitulo ?? undefined}
                >
                  {g.faltan === 0 ? '✓ ' : ''}{g.titulo}
                  <span className={`ml-1.5 ${g.key === activo?.key ? 'text-blue-100' : 'text-gray-400'}`}>
                    {g.faltan > 0 ? `${g.faltan}/${g.piezas.length}` : g.piezas.length}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Lista de piezas del ensamble activo */}
            <div className="bg-gray-50 rounded-lg border border-gray-100 p-3">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide truncate">
                  {activo.titulo}
                  <span className="ml-2 font-normal normal-case text-gray-400">
                    {piezasVisibles.length} {piezasVisibles.length === 1 ? 'pieza' : 'piezas'}
                  </span>
                </h3>
                <div className="flex items-center gap-3 shrink-0">
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={onlyMissing}
                      onChange={e => setOnlyMissing(e.target.checked)}
                      className="accent-blue-600"
                    />
                    solo faltantes
                  </label>
                  <button onClick={() => copy(listJson, 'list')} className="text-xs text-blue-600 hover:underline">
                    {copied === 'list' ? '¡Copiado!' : 'Copiar'}
                  </button>
                </div>
              </div>
              {piezasVisibles.length === 0 ? (
                <p className="text-xs text-gray-400 py-2">
                  Este grupo ya está completo. Destildá &quot;solo faltantes&quot; para recargar medidas igual.
                </p>
              ) : (
                <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-3 max-h-64 overflow-auto font-mono">{listJson}</pre>
              )}
            </div>

            {/* Prompt */}
            <div className="bg-gray-50 rounded-lg border border-gray-100 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Prompt para la IA</h3>
                <button onClick={() => copy(MEASURES_PROMPT, 'prompt')} className="text-xs text-blue-600 hover:underline">
                  {copied === 'prompt' ? '¡Copiado!' : 'Copiar'}
                </button>
              </div>
              <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-3 max-h-64 overflow-auto">{MEASURES_PROMPT}</pre>
            </div>
          </div>

          {/* Pegar la respuesta */}
          <form action={formAction} className="space-y-3">
            {assemblyId != null && <input type="hidden" name="assemblyId" value={assemblyId} />}
            {revalidate && <input type="hidden" name="revalidate" value={revalidate} />}
            <label className="block text-sm font-medium text-gray-700">Pegá la respuesta de la IA</label>
            <p className="text-xs text-gray-400 -mt-1">
              Podés pegar la respuesta completa (razonamiento + fuentes + JSON); se extrae el bloque{' '}
              <span className="font-mono">json</span> solo. Las piezas se buscan por{' '}
              <span className="font-mono">bajajCode</span> o <span className="font-mono">id</span>, así que no importa
              de qué ensamble vengan.
            </p>
            <textarea
              name="json"
              rows={8}
              placeholder="Pegá acá la respuesta de la IA (o solo el bloque JSON)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
            />
            <div className="flex justify-end">
              <SubmitButton />
            </div>
          </form>

          {state.message && (
            <div className={`rounded-lg border p-3 ${state.ok ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
              <p className={`text-sm font-medium ${state.ok ? 'text-green-800' : 'text-yellow-800'}`}>{state.message}</p>
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