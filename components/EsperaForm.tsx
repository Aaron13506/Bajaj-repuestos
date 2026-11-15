'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Miniatura from '@/components/Miniatura'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { ALL_MODELS, formatModels, shortModel, type MotoModelId } from '@/lib/modelo'
import { getAssemblyComponents, searchAssembliesByPiece, searchProducts } from '@/app/(pages)/presupuestos/builder-actions'

// Anotar una espera: se elige la pieza como en Ventas o en el armador de presupuestos (moto,
// buscador, ensamble con su despiece), pero sobre todo el catálogo y sin precios: acá no se cotiza,
// solo se anota quién la espera.

interface Ensamble {
  id: number
  nameEs: string
  imageUrl: string | null
  models: readonly MotoModelId[]
}

// Las variantes por moto de un mismo ensamble van juntas en una fila, como en Ventas.
interface Fila {
  nombre: string
  ids: number[]
  imageUrl: string | null
  models: MotoModelId[]
  match?: { pieceName: string; pieceCode: string }
}

interface Pieza {
  id: number
  nameEs: string
  bajajCode: string | null
  imageUrl: string | null
  models: readonly MotoModelId[]
  descontinuada: boolean
}

interface Componente {
  id: number
  groupName: string
  product: Pieza
}

type Coincidencias = Map<number, { pieceName: string; pieceCode: string }>
const sinCoincidencias: Coincidencias = new Map()

const campo = 'h-10 border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const etiqueta = 'flex flex-col gap-1 text-xs font-medium text-gray-600'
const subtitulo = 'text-xs font-semibold text-gray-600 uppercase tracking-wide'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  clientes: string[]
  ensambles: Ensamble[]
}

export default function EsperaForm({ action, clientes, ensambles }: Props) {
  const [modelFilter, setModelFilter] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [selectedNombre, setSelectedNombre] = useState<string | null>(null)
  const [compCache, setCompCache] = useState<Record<string, Componente[]>>({})
  const [cargando, setCargando] = useState(false)
  const [errorPiezas, setErrorPiezas] = useState(false)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [elegidas, setElegidas] = useState<Pieza[]>([])
  const [intento, setIntento] = useState(false)
  const { enviar, isPending, error } = useEnviarAccion(action, () => {})

  // Un solo campo busca ensambles (por nombre o por el SKU de una pieza de adentro) y piezas sueltas.
  const termino = busqueda.trim()
  const activo = termino.length >= 2
  const [hechas, setHechas] = useState<{ q: string; matches: Coincidencias; piezas: Pieza[]; error: boolean }>({ q: '', matches: sinCoincidencias, piezas: [], error: false })
  const respondida = activo && hechas.q === termino
  const coincidencias = activo ? hechas.matches : sinCoincidencias
  const piezasCoinciden = respondida
    ? hechas.piezas.filter(p => !modelFilter || p.models.length === 0 || p.models.includes(modelFilter as MotoModelId))
    : []

  useEffect(() => {
    if (termino.length < 2) return
    let cancelado = false
    const t = setTimeout(async () => {
      let matches: Coincidencias = new Map()
      let piezas: Pieza[] = []
      let error = false
      try {
        const [rows, prods] = await Promise.all([searchAssembliesByPiece(termino), searchProducts(termino)])
        matches = new Map(rows.map(r => [r.ensambleId, { pieceName: r.pieceName, pieceCode: r.pieceCode }]))
        piezas = prods
      } catch {
        error = true
      }
      if (!cancelado) setHechas({ q: termino, matches, piezas, error })
    }, 250)
    return () => { cancelado = true; clearTimeout(t) }
  }, [termino])

  // Sin moto ni búsqueda no se listan los ~1500 ensambles: no se recorren a mano.
  const filas = useMemo(() => {
    if (!modelFilter && !activo) return []
    const q = termino.toLowerCase()
    const porNombre = new Map<string, Fila>()
    for (const a of ensambles) {
      if (modelFilter && !a.models.includes(modelFilter as MotoModelId)) continue
      if (q && !a.nameEs.toLowerCase().includes(q) && !coincidencias.has(a.id)) continue
      const f = porNombre.get(a.nameEs) ?? { nombre: a.nameEs, ids: [], imageUrl: null, models: [] }
      f.ids.push(a.id)
      f.imageUrl ??= a.imageUrl
      f.models = [...new Set([...f.models, ...a.models])]
      f.match ??= coincidencias.get(a.id)
      porNombre.set(a.nameEs, f)
    }
    return [...porNombre.values()].sort((x, y) => x.nombre.localeCompare(y.nombre))
  }, [ensambles, modelFilter, activo, termino, coincidencias])

  const seleccionado = filas.find(f => f.nombre === selectedNombre) ?? null
  const componentes = seleccionado ? compCache[seleccionado.ids.join(',')] : undefined

  async function seleccionar(f: Fila | null) {
    setSelectedNombre(f?.nombre ?? null)
    setChecked({})
    setErrorPiezas(false)
    const k = f?.ids.join(',') ?? ''
    if (!f || compCache[k]) return
    setCargando(true)
    try {
      // Con varias motos juntas los subgrupos no significan nada: una lista sola, cada pieza una vez.
      const varias = f.ids.length > 1
      const vistos = new Set<string>()
      const comps = (await Promise.all(f.ids.map(id => getAssemblyComponents(id)))).flat()
        .map(c => (varias ? { ...c, groupName: '' } : c))
        .filter(c => {
          const id = `${c.groupName}|${c.product.id}`
          return !vistos.has(id) && !!vistos.add(id)
        })
      if (varias) comps.sort((a, b) => a.product.nameEs.localeCompare(b.product.nameEs))
      setCompCache(prev => ({ ...prev, [k]: comps }))
    } catch {
      setErrorPiezas(true)
    } finally {
      setCargando(false)
    }
  }

  const grupos = useMemo(() => {
    const m = new Map<string, Componente[]>()
    for (const c of componentes ?? []) {
      const k = c.groupName || '—'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(c)
    }
    return m
  }, [componentes])

  const yaElegida = (id: number) => elegidas.some(p => p.id === id)
  const agregar = (p: Pieza) => setElegidas(ls => (ls.some(x => x.id === p.id) ? ls : [...ls, p]))
  function agregarMarcadas() {
    for (const c of componentes ?? []) if (checked[c.id]) agregar(c.product)
    setChecked({})
  }
  const cantMarcadas = Object.values(checked).filter(Boolean).length

  function anotar(e: FormEvent<HTMLFormElement>) {
    if (elegidas.length === 0) {
      e.preventDefault()
      setIntento(true)
      return
    }
    enviar(e)
  }

  const textoEstado = !activo
    ? (modelFilter ? '' : 'Elegí la moto o buscá por nombre o código.')
    : !respondida
      ? 'Buscando…'
      : hechas.error
        ? 'No se pudo buscar. Probá de nuevo.'
        : piezasCoinciden.length === 0 && filas.length === 0
          ? `Nada coincide con "${termino}".`
          : `${piezasCoinciden.length} ${piezasCoinciden.length === 1 ? 'pieza' : 'piezas'} y ${filas.length} ${filas.length === 1 ? 'ensamble' : 'ensambles'}.`

  return (
    <form
      onSubmit={anotar}
      noValidate
      onKeyDown={e => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).name !== 'nota') e.preventDefault() }}
    >
      <input type="hidden" name="productIds" value={JSON.stringify(elegidas.map(p => p.id))} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] gap-6 items-start">
        {/* ── Izquierda: buscar en el catálogo ── */}
        <section aria-labelledby="espera-buscar" className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 space-y-5 min-w-0">
          <h2 id="espera-buscar" className="text-base font-semibold text-gray-900">Buscar la pieza</h2>

          <div className="grid grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)] gap-3">
            <label className={etiqueta}>
              Moto
              <select
                className={campo}
                value={modelFilter}
                onChange={e => { setModelFilter(e.target.value); setSelectedNombre(null); setChecked({}) }}
              >
                <option value="">Todas las motos</option>
                {ALL_MODELS.map(m => <option key={m.id} value={m.id}>{shortModel(m.id)}</option>)}
              </select>
            </label>
            <label className={etiqueta}>
              Pieza, código o ensamble
              <input
                type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)}
                placeholder="Ej.: pastilla, JF191044, pinza…" autoComplete="off" autoFocus
                className={campo}
              />
            </label>
          </div>
          <p role="status" className={`text-sm min-h-5 ${hechas.error && respondida ? 'text-red-700' : 'text-gray-500'}`}>{textoEstado}</p>

          {piezasCoinciden.length > 0 && (
            <div>
              <h3 className={`${subtitulo} mb-2`}>Piezas · {piezasCoinciden.length}</h3>
              <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {piezasCoinciden.map(p => {
                  const ya = yaElegida(p.id)
                  return (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Miniatura src={p.imageUrl} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium break-words ${p.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}`}>{p.nameEs}</p>
                        <p className="text-xs text-gray-500 break-words">
                          {p.bajajCode && <span className="font-mono">{p.bajajCode}</span>}
                          {p.models.length > 0 && <> · {formatModels(p.models)}</>}
                          {p.descontinuada && <span className="text-red-700"> · descontinuada</span>}
                        </p>
                      </div>
                      <button
                        type="button" disabled={ya} onClick={() => agregar(p)}
                        className={`shrink-0 min-h-9 w-28 rounded-lg text-sm font-semibold transition-colors ${
                          ya ? 'border border-green-200 bg-green-50 text-green-800' : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        {ya ? '✓ Elegida' : 'Agregar'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {filas.length > 0 && (
            <div>
              <h3 className={`${subtitulo} mb-2`}>Ensambles · {filas.length}</h3>
              <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {filas.map(a => {
                  const abierto = a.nombre === selectedNombre
                  const panel = `despiece-${a.ids[0]}`
                  return (
                    <li key={a.nombre}>
                      <button
                        type="button" aria-expanded={abierto} aria-controls={abierto ? panel : undefined}
                        onClick={() => seleccionar(abierto ? null : a)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${abierto ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      >
                        <Miniatura src={a.imageUrl} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold text-gray-900 break-words">{a.nombre}</span>
                          <span className="block text-xs text-gray-500 truncate">{formatModels(a.models)}</span>
                          {a.match && (
                            <span className="block text-xs text-amber-800 truncate">
                              contiene <span className="font-mono">{a.match.pieceCode}</span> · {a.match.pieceName}
                            </span>
                          )}
                        </span>
                        <svg aria-hidden="true" className={`size-4 shrink-0 text-gray-500 transition-transform ${abierto ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {abierto && (
                        <div id={panel} className="border-t border-blue-100 bg-white px-3 py-3 space-y-3">
                          {a.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={a.imageUrl} alt={`Despiece de ${a.nombre}`} loading="lazy" className="w-full max-h-96 object-contain rounded-lg border border-gray-100 bg-white" />
                          )}
                          {cargando && !componentes ? (
                            <p role="status" className="text-sm text-gray-500 py-4 text-center">Cargando piezas…</p>
                          ) : errorPiezas && !componentes ? (
                            <p role="alert" className="text-sm text-red-700 py-4 text-center">No se pudieron cargar las piezas. Cerrá y volvé a abrir el ensamble.</p>
                          ) : (
                            <fieldset className="space-y-3">
                              <legend className="sr-only">Piezas de {a.nombre}</legend>
                              {Array.from(grupos.entries()).map(([nombre, items]) => (
                                <div key={nombre}>
                                  {nombre !== '—' && <p className={`${subtitulo} mb-1`}>{nombre}</p>}
                                  {items.map(c => {
                                    const ya = yaElegida(c.product.id)
                                    const nls = c.product.descontinuada
                                    return (
                                      <label key={c.id} className={`flex items-center gap-3 min-h-11 py-1 ${ya || nls ? 'text-gray-500' : 'cursor-pointer text-gray-900'}`}>
                                        <input
                                          type="checkbox" checked={!!checked[c.id]} disabled={ya || nls}
                                          onChange={e => setChecked(prev => ({ ...prev, [c.id]: e.target.checked }))}
                                          className="size-4 rounded border-gray-300 text-blue-600 shrink-0"
                                        />
                                        <span className="min-w-0 text-sm">
                                          <span className={nls ? 'line-through' : undefined}>{c.product.nameEs}</span>
                                          {c.product.bajajCode && <span className="ml-1.5 text-xs font-mono text-gray-500">{c.product.bajajCode}</span>}
                                          {nls && <span className="ml-1 text-xs text-red-700">· descontinuada</span>}
                                          {ya && <span className="ml-1 text-xs text-blue-800">· ya elegida</span>}
                                        </span>
                                      </label>
                                    )
                                  })}
                                </div>
                              ))}
                            </fieldset>
                          )}
                          <button
                            type="button" onClick={agregarMarcadas} disabled={cantMarcadas === 0}
                            className="w-full min-h-10 rounded-lg border border-blue-300 bg-white text-blue-700 text-sm font-semibold hover:bg-blue-50 disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-white transition-colors"
                          >
                            {cantMarcadas === 0 ? 'Marcá las piezas que espera' : `Agregar ${cantMarcadas} ${cantMarcadas === 1 ? 'marcada' : 'marcadas'}`}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>

        {/* ── Derecha: la espera. Fija en pantalla grande mientras se busca a la izquierda. ── */}
        <aside aria-labelledby="espera-ficha" className="bg-white rounded-xl border border-gray-200 lg:sticky lg:top-4 divide-y divide-gray-100 min-w-0">
          <div className="p-4 sm:p-5 space-y-3">
            <h2 id="espera-ficha" className="text-base font-semibold text-gray-900">La espera</h2>
            <label className={etiqueta}>
              <span>Cliente <span className="text-red-700" aria-hidden="true">*</span><span className="sr-only">(obligatorio)</span></span>
              <input name="nombre" list="espera-clientes" required autoComplete="off" placeholder="Nombre (si no existe, se crea)" className={campo} />
              <datalist id="espera-clientes">
                {clientes.map(n => <option key={n} value={n} />)}
              </datalist>
            </label>
          </div>

          <div className="p-4 sm:p-5">
            <h3 className={`${subtitulo} mb-2`}>Piezas · {elegidas.length}</h3>
            {elegidas.length === 0 ? (
              <p className={`text-sm border border-dashed rounded-lg px-4 py-6 text-center ${intento ? 'border-red-300 text-red-700' : 'border-gray-300 text-gray-500'}`}>
                {intento ? 'Agregá al menos una pieza.' : 'Buscá a la izquierda y agregá las que espera.'}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {elegidas.map(p => (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    <Miniatura src={p.imageUrl} />
                    <span className="flex-1 min-w-0 text-sm text-gray-900 break-words">
                      {p.nameEs}
                      {p.bajajCode && <span className="block text-xs font-mono text-gray-500">{p.bajajCode}</span>}
                    </span>
                    <button
                      type="button" onClick={() => setElegidas(ls => ls.filter(x => x.id !== p.id))}
                      aria-label={`Quitar ${p.nameEs}`}
                      className="shrink-0 size-9 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                    >
                      <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="p-4 sm:p-5 space-y-3">
            <label className={etiqueta}>
              <span>Nota <span className="font-normal text-gray-500">(opcional)</span></span>
              <input name="nota" placeholder="Cuántas, para qué moto…" autoComplete="off" className={campo} />
            </label>
            {error && <p role="alert" className="text-sm text-red-800 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit" disabled={isPending}
              className="w-full min-h-11 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {isPending ? 'Anotando…' : elegidas.length > 1 ? `Anotar ${elegidas.length} piezas` : 'Anotar espera'}
            </button>
          </div>
        </aside>
      </div>
    </form>
  )
}
