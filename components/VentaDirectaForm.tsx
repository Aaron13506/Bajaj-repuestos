'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import MontoBs from '@/components/MontoBs'
import CamposDevolucion from '@/components/CamposDevolucion'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { cobraEnBolivares } from '@/lib/pagos'
import { resumenCobro, type ResumenCobro } from '@/lib/cobro-bcv'
import { resumenVenta } from '@/lib/venta-stock'
import { ALL_MODELS, formatModels, shortModel, type MotoModelId } from '@/lib/modelo'
import { buscarEnStock, getComponentesEnStock, type PiezaEnStock } from '@/app/(pages)/ventas/actions'
import { searchAssembliesByPiece } from '@/app/(pages)/presupuestos/builder-actions'

interface Ensamble {
  id: number
  nameEs: string
  imageUrl: string | null
  models: readonly MotoModelId[]
  /** Lo que hay en el depósito de este ensamble. */
  piezas: { id: number; nameEs: string; stock: number }[]
}

// Una fila de la lista: todas las variantes por moto de un mismo ensamble ("Tank Fairing" de la
// N160 y de la N250 son el mismo despiece). Listadas una por variante, una sola pieza en stock
// llenaba la lista con el mismo ensamble repetido.
interface Fila {
  nombre: string
  ids: number[]
  imageUrl: string | null
  models: MotoModelId[]
  piezas: Ensamble['piezas']
  match?: { pieceName: string; pieceCode: string }
}

interface Componente {
  id: number
  groupName: string
  product: PiezaEnStock
}

// Una línea del carrito: lo escrito se guarda como texto para no pelearse con el cursor.
interface Linea {
  pieza: PiezaEnStock
  cantidad: string
  precio: string
  costo: string
}

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  clientes: { id: number; nombre: string; telefono: string | null }[]
  /** Solo los ensambles que tienen algo en el depósito. */
  ensambles: Ensamble[]
  /** Solo las motos de las que hay algo en el depósito. */
  motos: readonly MotoModelId[]
  metodos: readonly string[]
  /** Escalón de brecha de hoy: el total se le presenta al cliente a dólar BCV. Null = sin tasa BCV cargada. */
  escalon: number | null
  tasaBcv: number
  tasaDirecta: number
}

type Coincidencias = Map<number, { pieceName: string; pieceCode: string }>
const sinCoincidencias: Coincidencias = new Map()

const usd = (n: number) => `$${n.toFixed(2)}`
const entero = (s: string) => parseInt(s, 10)
const decimal = (s: string) => parseFloat(s.replace(',', '.'))
const campo = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

// Vender algo del depósito: se busca igual que en un presupuesto (por moto, por ensamble o por
// pieza), pero solo aparece lo que hay en stock. Sin presupuesto ni caja: se elige el cliente
// —queda a su nombre—, se ve lo que cuestan las piezas y lo que se gana, y se cobra (o se deja
// por cobrar) en el mismo paso.
export default function VentaDirectaForm({ action, clientes, ensambles, motos, metodos, escalon, tasaBcv, tasaDirecta }: Props) {
  const [modelFilter, setModelFilter] = useState('')
  const [asmSearch, setAsmSearch] = useState('')
  const [selectedNombre, setSelectedNombre] = useState<string | null>(null)
  const [compCache, setCompCache] = useState<Record<string, Componente[]>>({})
  const [cargando, setCargando] = useState(false)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [cantidades, setCantidades] = useState<Record<number, number>>({})

  const [busqueda, setBusqueda] = useState('')
  const [encontradas, setEncontradas] = useState<PiezaEnStock[]>([])
  const pedido = useRef(0)

  const [lineas, setLineas] = useState<Linea[]>([])
  const [clienteId, setClienteId] = useState('')
  const [cobrado1, setCobrado1] = useState(0)
  const [cobrado2, setCobrado2] = useState(0)
  const [segundo, setSegundo] = useState(false)
  const [conVuelto, setConVuelto] = useState(false)
  const { enviar, isPending, error } = useEnviarAccion(action, () => {})

  // ── Ensambles ──────────────────────────────────────────────────────────────
  // El texto también busca el SKU de una pieza de adentro (el cliente llega con el código de la
  // pieza, no con el del ensamble). Se guarda junto con el término al que contesta, así
  // "buscando" se deriva al renderizar y no se prende y apaga desde el efecto.
  // De paso trae las piezas en stock que coinciden: si el cliente llegó con el código, lo que
  // busca es la pieza, y se agrega directo sin pasar por sus ensambles.
  const [piezasHechas, setPiezasHechas] = useState<{ q: string; matches: Coincidencias; piezas: PiezaEnStock[] }>({ q: '', matches: sinCoincidencias, piezas: [] })
  const termino = asmSearch.trim()
  const clave = `${termino}|${modelFilter}`
  const piezasActivo = termino.length >= 2
  const coincidencias = piezasActivo ? piezasHechas.matches : sinCoincidencias
  const piezasCoinciden = piezasActivo && piezasHechas.q === clave ? piezasHechas.piezas : []
  const buscandoPiezas = piezasActivo && piezasHechas.q !== clave

  useEffect(() => {
    if (termino.length < 2) return
    let cancelado = false
    const t = setTimeout(async () => {
      let matches: Coincidencias = new Map()
      let piezas: PiezaEnStock[] = []
      try {
        const [rows, enStock] = await Promise.all([searchAssembliesByPiece(termino), buscarEnStock(termino, modelFilter || undefined)])
        matches = new Map(rows.map(r => [r.ensambleId, { pieceName: r.pieceName, pieceCode: r.pieceCode }]))
        piezas = enStock
      } catch {
        // Sin resultados para este término: igual se marca como respondido.
      }
      if (!cancelado) setPiezasHechas({ q: `${termino}|${modelFilter}`, matches, piezas })
    }, 250)
    return () => { cancelado = true; clearTimeout(t) }
  }, [termino, modelFilter])

  // Las variantes que pasan el filtro, juntadas por nombre. Primero los ensambles de los que
  // tengo más piezas: el que solo comparte un tornillo queda al fondo.
  const filas = useMemo(() => {
    const q = asmSearch.trim().toLowerCase()
    const porNombre = new Map<string, Fila>()
    for (const a of ensambles) {
      if (modelFilter && !a.models.includes(modelFilter as MotoModelId)) continue
      if (q && !a.nameEs.toLowerCase().includes(q) && !coincidencias.has(a.id)) continue
      const f = porNombre.get(a.nameEs) ?? { nombre: a.nameEs, ids: [], imageUrl: null, models: [], piezas: [] }
      f.ids.push(a.id)
      f.imageUrl ??= a.imageUrl
      f.models = [...new Set([...f.models, ...a.models])]
      for (const p of a.piezas) if (!f.piezas.some(x => x.id === p.id)) f.piezas.push(p)
      f.match ??= coincidencias.get(a.id)
      porNombre.set(a.nameEs, f)
    }
    return [...porNombre.values()].sort((x, y) => y.piezas.length - x.piezas.length || x.nombre.localeCompare(y.nombre))
  }, [ensambles, modelFilter, asmSearch, coincidencias])

  const seleccionado = filas.find(f => f.nombre === selectedNombre) ?? null
  const componentes = seleccionado ? compCache[seleccionado.ids.join(',')] : undefined

  async function seleccionar(f: Fila | null) {
    setSelectedNombre(f?.nombre ?? null)
    setChecked({})
    setCantidades({})
    const k = f?.ids.join(',') ?? ''
    if (f && !compCache[k]) {
      setCargando(true)
      try {
        // Cada moto nombra distinto el subgrupo de la misma pieza ("Bearings", "Wheel Bearing",
        // "Coupling"): con varias variantes juntas los subgrupos no significan nada, así que va
        // una lista sola con cada pieza una vez.
        const vistos = new Set<string>()
        const varias = f.ids.length > 1
        const comps = (await getComponentesEnStock(f.ids))
          .map(c => (varias ? { ...c, groupName: '' } : c))
          .filter(c => {
            const id = `${c.groupName}|${c.product.id}`
            return !vistos.has(id) && !!vistos.add(id)
          })
        if (varias) comps.sort((a, b) => a.product.nameEs.localeCompare(b.product.nameEs))
        setCompCache(prev => ({ ...prev, [k]: comps }))
      } finally {
        setCargando(false)
      }
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

  const enCarrito = (id: number) => lineas.some(l => l.pieza.id === id)

  function agregarPieza(p: PiezaEnStock, cantidad = 1) {
    setLineas(ls => {
      const cant = Math.max(1, Math.min(cantidad, p.stock))
      const i = ls.findIndex(l => l.pieza.id === p.id)
      if (i >= 0) return ls // ya está: se cambia la cantidad en el carrito
      return [...ls, { pieza: p, cantidad: String(cant), precio: p.price.toFixed(2), costo: p.costoUnitUsd != null ? p.costoUnitUsd.toFixed(2) : '' }]
    })
  }

  function agregarMarcadas() {
    // Una misma pieza puede estar en varios subgrupos del ensamble: se suman las cantidades.
    const porPieza = new Map<number, { pieza: PiezaEnStock; cantidad: number }>()
    for (const c of componentes ?? []) {
      if (!checked[c.id] || enCarrito(c.product.id)) continue
      const cant = cantidades[c.id] ?? 1
      const previo = porPieza.get(c.product.id)
      porPieza.set(c.product.id, { pieza: c.product, cantidad: (previo?.cantidad ?? 0) + cant })
    }
    for (const { pieza, cantidad } of porPieza.values()) agregarPieza(pieza, cantidad)
    setChecked({})
    setCantidades({})
  }

  // ── Pieza individual ───────────────────────────────────────────────────────
  async function buscar(texto: string, modelo = modelFilter) {
    setBusqueda(texto)
    const n = ++pedido.current
    const rows = texto.trim().length >= 2 ? await buscarEnStock(texto, modelo || undefined) : []
    // Una respuesta vieja no pisa a la última que se pidió.
    if (n === pedido.current) setEncontradas(rows)
  }

  // ── Carrito, totales y cobro ───────────────────────────────────────────────
  const cambiar = (id: number, c: 'cantidad' | 'precio' | 'costo', valor: string) =>
    setLineas(ls => ls.map(l => (l.pieza.id === id ? { ...l, [c]: valor } : l)))

  const parseadas = lineas.map(l => ({
    productId: l.pieza.id,
    quantity: entero(l.cantidad),
    salePrice: decimal(l.precio),
    costoUnitUsd: decimal(l.costo),
  }))
  const completas = parseadas.every(l => Number.isInteger(l.quantity) && l.quantity > 0 && l.salePrice >= 0 && l.costoUnitUsd > 0)
  const excedeStock = lineas.some(l => entero(l.cantidad) > l.pieza.stock)
  const hayLineas = lineas.length > 0 && completas

  const resumen = hayLineas ? resumenVenta(parseadas) : null
  const cobro = hayLineas
    ? resumenCobro(parseadas.map(l => ({ salePrice: l.salePrice, quantity: l.quantity })), 0, escalon)
    : null

  const modoBcv = escalon != null
  // Lo que pagó de más (dólares reales): es el vuelto que se propone.
  const pagado = cobrado1 + (segundo ? cobrado2 : 0)
  const sobra = cobro ? Math.max(0, Math.round((pagado - cobro.totalReal) * 100) / 100) : 0
  const listo = hayLineas && !excedeStock && clienteId !== ''

  const motosVisibles = ALL_MODELS.filter(m => motos.includes(m.id))
  const cantMarcadas = Object.values(checked).filter(Boolean).length

  return (
    <form onSubmit={enviar} onKeyDown={e => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault() }}>
      <input type="hidden" name="items" value={JSON.stringify(parseadas)} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* ── Izquierda: buscar lo que tengo ── */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-4">Agregar por ensamble</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <select
                className={`w-full ${campo}`}
                value={modelFilter}
                onChange={e => { setModelFilter(e.target.value); setSelectedNombre(null); setChecked({}); setCantidades({}); buscar(busqueda, e.target.value) }}
              >
                <option value="">— Todas las motos —</option>
                {motosVisibles.map(m => <option key={m.id} value={m.id}>{shortModel(m.id)}</option>)}
              </select>
              <input
                type="text" value={asmSearch} onChange={e => setAsmSearch(e.target.value)}
                placeholder="Buscar por nombre, código o SKU de una pieza..."
                className={`w-full ${campo}`}
              />
            </div>

            {piezasCoinciden.length > 0 && (
              <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg mb-2 divide-y divide-emerald-100">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold text-emerald-800 uppercase tracking-wide">Piezas en stock que coinciden</p>
                {piezasCoinciden.map(p => (
                  <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{p.nameEs}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {p.bajajCode && <span className="font-mono">{p.bajajCode} · </span>}hay {p.stock} · {usd(p.price)}
                      </p>
                    </div>
                    <button
                      type="button" disabled={enCarrito(p.id)} onClick={() => agregarPieza(p)}
                      className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {enCarrito(p.id) ? 'Agregada' : 'Agregar'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="border border-gray-300 rounded-lg mb-1 max-h-72 overflow-y-auto divide-y divide-gray-50">
              {filas.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">
                  {buscandoPiezas ? 'Buscando…' : ensambles.length === 0 ? 'No hay ninguna pieza en el depósito.' : 'Sin resultados'}
                </p>
              ) : (
                filas.map(a => {
                  const match = a.match
                  return (
                    <button
                      key={a.nombre} type="button" onClick={() => seleccionar(a.nombre === selectedNombre ? null : a)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${a.nombre === selectedNombre ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      {a.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.imageUrl} alt={a.nombre} loading="lazy" className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{a.nombre}</p>
                        <p className="text-xs text-gray-400 truncate">{formatModels(a.models)}</p>
                        <p className="text-[11px] text-emerald-700 truncate">
                          tenés: {a.piezas.map(p => `${p.nameEs} (${p.stock})`).join(', ')}
                        </p>
                        {match && (
                          <p className="text-[11px] text-amber-700 truncate">
                            contiene <span className="font-mono">{match.pieceCode}</span> · {match.pieceName}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                        {a.piezas.length} pieza{a.piezas.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {filas.length} ensamble{filas.length === 1 ? '' : 's'} con piezas en el depósito
              {modelFilter || asmSearch ? ' (filtrado)' : ''}.
            </p>

            {seleccionado && (
              <>
                <div className="flex items-center gap-3 mb-3 pb-3 border-b border-gray-100">
                  {seleccionado.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={seleccionado.imageUrl} alt={seleccionado.nombre} className="w-16 h-16 object-contain rounded-lg border border-gray-100 bg-white shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{seleccionado.nombre}</p>
                    <p className="text-xs text-gray-400">Solo las piezas que tenés en el depósito.</p>
                  </div>
                </div>
                {seleccionado.ids.length > 1 && (
                  // Juntas, las motos mezclan las piezas: se elige la del cliente y se ve el despiece de esa.
                  <div className="mb-3 pb-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 mb-2">¿Para qué moto? Cuántas de tus {seleccionado.piezas.length} piezas lleva cada una:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {ensambles.filter(a => seleccionado.ids.includes(a.id)).map(a => {
                        const moto = a.models[0]
                        const lleva = new Set(a.piezas.map(p => p.id)).size
                        return (
                          <button
                            key={a.id} type="button"
                            onClick={() => {
                              if (!moto) return
                              setModelFilter(moto)
                              buscar(busqueda, moto)
                              seleccionar({ ...seleccionado, ids: seleccionado.ids.filter(id => ensambles.find(x => x.id === id)?.models.includes(moto)) })
                            }}
                            className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50"
                          >
                            {moto ? shortModel(moto) : a.nameEs} <span className="font-semibold text-emerald-700">· {lleva}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {cargando && !componentes ? (
                  <p className="text-sm text-gray-400 py-6 text-center">Cargando piezas…</p>
                ) : (
                  <div className="space-y-4 max-h-80 overflow-y-auto pr-1">
                    {Array.from(grupos.entries()).map(([nombre, items]) => (
                      <div key={nombre}>
                        {nombre !== '—' && <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{nombre}</p>}
                        <div className="space-y-0.5">
                          {items.map(c => {
                            const ya = enCarrito(c.product.id)
                            return (
                              <label key={c.id} className={`flex items-center gap-3 py-2 px-2 rounded-lg ${ya ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50'}`}>
                                <input
                                  type="checkbox" checked={!!checked[c.id]} disabled={ya}
                                  onChange={e => setChecked(prev => ({ ...prev, [c.id]: e.target.checked }))}
                                  className="w-4 h-4 rounded border-gray-300 text-blue-600 shrink-0"
                                />
                                <span className="flex-1 min-w-0 text-sm text-gray-900">
                                  {c.product.nameEs}
                                  {c.product.bajajCode && <span className="ml-2 text-xs font-mono text-gray-400">{c.product.bajajCode}</span>}
                                  {ya && <span className="ml-2 text-xs text-blue-500">ya agregado</span>}
                                  <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">hay {c.product.stock}</span>
                                  {c.product.models.length > 0 && (
                                    <span className="block text-[11px] text-gray-400">sirve en {formatModels(c.product.models)}</span>
                                  )}
                                </span>
                                <input
                                  type="number" min={1} max={c.product.stock} value={cantidades[c.id] ?? 1}
                                  onChange={e => setCantidades(prev => ({ ...prev, [c.id]: Math.min(parseInt(e.target.value) || 1, c.product.stock) }))}
                                  onClick={e => e.stopPropagation()} disabled={!checked[c.id] || ya}
                                  className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center disabled:opacity-40"
                                />
                                <span className="text-sm text-gray-600 w-16 text-right font-mono">{usd(c.product.price)}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button" onClick={agregarMarcadas} disabled={cantMarcadas === 0}
                  className="mt-4 w-full bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Agregar piezas marcadas{cantMarcadas > 0 ? ` (${cantMarcadas})` : ''}
                </button>
              </>
            )}
          </div>

          {/* Pieza individual */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">Agregar pieza individual</h2>
            <div className="relative">
              <input
                type="text" placeholder="Buscar por nombre o código (solo lo que tengo)..."
                value={busqueda} onChange={e => buscar(e.target.value)}
                className={`w-full ${campo}`}
              />
              {encontradas.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg divide-y divide-gray-50 overflow-hidden max-h-96 overflow-y-auto">
                  {encontradas.map(p => (
                    <button
                      key={p.id} type="button" disabled={enCarrito(p.id)}
                      onClick={() => { agregarPieza(p); setBusqueda(''); setEncontradas([]) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt={p.nameEs} className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{p.nameEs}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {p.bajajCode && <span className="font-mono">{p.bajajCode}</span>}
                          {p.bajajCode && p.models.length > 0 && ' · '}
                          {formatModels(p.models)}
                        </p>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">hay {p.stock}</span>
                        {enCarrito(p.id) && <span className="ml-2 text-xs text-blue-500">ya agregado</span>}
                      </div>
                      <span className="text-sm font-mono text-gray-600 shrink-0">{usd(p.price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Derecha: cliente, piezas, cobro ── */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-3">
            <h2 className="font-semibold text-gray-900">Cliente <span className="text-red-500">*</span></h2>
            <select name="clienteId" value={clienteId} onChange={e => setClienteId(e.target.value)} required className={`w-full ${campo}`}>
              <option value="">Elegí un cliente…</option>
              {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              <option value="__new__">+ Nuevo cliente</option>
            </select>
            {clienteId === '__new__' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input type="text" name="nuevoClienteNombre" placeholder="Nombre del cliente" required className={`w-full ${campo}`} />
                <input type="text" name="nuevoClienteTelefono" placeholder="Teléfono (opcional)" className={`w-full ${campo}`} />
              </div>
            )}
            <p className="text-[11px] text-gray-400">La venta queda a su nombre en su ficha de cliente.</p>
            <input type="text" name="notas" placeholder="Nota (opcional)" className={`w-full ${campo}`} />
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">
              Piezas a vender
              {lineas.length > 0 && <span className="ml-2 text-xs font-normal text-gray-400">{lineas.length} {lineas.length === 1 ? 'pieza' : 'piezas'}</span>}
            </h2>
            {lineas.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">Buscá a la izquierda lo que se lleva el cliente.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400">
                    <th className="py-1 font-medium">Pieza</th>
                    <th className="py-1 font-medium w-16">Cant.</th>
                    <th className="py-1 font-medium w-24">Precio</th>
                    <th className="py-1 font-medium w-24">Costo</th>
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {lineas.map(l => {
                    const cant = entero(l.cantidad)
                    return (
                      <tr key={l.pieza.id} className="align-top">
                        <td className="py-2 pr-2">
                          {l.pieza.nameEs}
                          <span className="block text-[11px] text-gray-400">
                            {l.pieza.bajajCode ?? 'sin código'} · hay {l.pieza.stock}
                            {cant > l.pieza.stock && <span className="text-red-600 font-semibold"> · no alcanza</span>}
                            {l.pieza.costoUnitUsd == null && <span className="text-amber-700"> · sin costo cargado: escribilo</span>}
                          </span>
                        </td>
                        <td className="py-2 pr-1"><input type="number" min={1} max={l.pieza.stock} step={1} value={l.cantidad} onChange={e => cambiar(l.pieza.id, 'cantidad', e.target.value)} className="w-14 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono" /></td>
                        <td className="py-2 pr-1"><input type="number" min={0} step="0.01" value={l.precio} onChange={e => cambiar(l.pieza.id, 'precio', e.target.value)} className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono" /></td>
                        <td className="py-2 pr-1"><input type="number" min={0.01} step="0.01" value={l.costo} onChange={e => cambiar(l.pieza.id, 'costo', e.target.value)} className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono" /></td>
                        <td className="py-2 text-right"><button type="button" onClick={() => setLineas(ls => ls.filter(x => x.pieza.id !== l.pieza.id))} className="text-gray-400 hover:text-red-600" aria-label="Quitar">×</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {resumen && cobro && (
              <div className="mt-3 pt-3 border-t border-gray-100 text-sm space-y-1">
                <p>
                  Total <strong className="font-mono">{usd(cobro.totalReal)}</strong> en divisas
                  {modoBcv && <> · <strong className="font-mono">{usd(cobro.totalBcv)}</strong> a tasa BCV</>}
                </p>
                <p className="text-gray-500">
                  Costo <span className="font-mono">{usd(resumen.costoUsd)}</span> · ganás{' '}
                  <span className={`font-mono font-semibold ${resumen.margenUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {usd(resumen.margenUsd)} ({resumen.margenPct.toFixed(1)}%)
                  </span>
                </p>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">Cobro</h2>
            <div className="flex flex-wrap items-start gap-4">
              <FilaCobro
                sufijo="" metodos={metodos} metodoInicial={metodos[0]} cobro={cobro} yaCobrado={0}
                modoBcv={modoBcv} tasaBcv={tasaBcv} tasaDirecta={tasaDirecta} onReal={setCobrado1}
              />
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
                <CampoFecha name="fecha" className={campo} />
              </div>
            </div>
            {segundo ? (
              <div className="flex flex-wrap items-start gap-4 border-t border-gray-100 mt-4 pt-4">
                <FilaCobro
                  sufijo="2" metodos={metodos} metodoInicial={metodos[1] ?? metodos[0]} cobro={cobro} yaCobrado={cobrado1}
                  modoBcv={modoBcv} tasaBcv={tasaBcv} tasaDirecta={tasaDirecta} onReal={setCobrado2}
                />
                <button type="button" onClick={() => setSegundo(false)} className="text-xs text-gray-500 hover:text-red-600 mt-6">
                  Quitar
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setSegundo(true)} className="text-xs text-blue-600 hover:underline mt-3">
                + Pagó una parte con otro método
              </button>
            )}
            <div className="border-t border-gray-100 mt-4 pt-3 space-y-2">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={conVuelto} onChange={e => setConVuelto(e.target.checked)} className="rounded border-gray-300" />
                Le di vuelto{sobra > 0 && <span className="text-gray-400">(pagó {usd(sobra)} de más)</span>}
              </label>
              {conVuelto && (
                <div className="w-64">
                  <CamposDevolucion
                    key={sobra.toFixed(2)}
                    sugerido={sobra}
                    tasaSugerida={tasaDirecta}
                    etiqueta="Vuelto (USD reales)"
                    ayuda="Lo que le devolviste porque pagó de más. Puede ser por otro medio que el pago."
                  />
                </div>
              )}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Dejá el monto vacío si todavía no pagó: queda por cobrar y lo registrás después desde el pedido.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit" disabled={!listo || isPending}
              className="bg-green-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
            >
              {isPending ? 'Registrando…' : 'Registrar venta'}
            </button>
            {!listo && (
              <span className="text-xs text-gray-400">
                {lineas.length === 0 ? 'Agregá al menos una pieza.'
                  : excedeStock ? 'Hay una cantidad mayor al stock.'
                  : !completas ? 'Completá cantidad, precio y costo de cada pieza.'
                  : 'Elegí un cliente.'}
              </span>
            )}
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </form>
  )
}

// Un cobro de la venta: método y monto. Con `sufijo` '2' es el segundo método del mismo pago
// (parte en Bs, parte en efectivo); su sugerido es lo que falta después del primero.
function FilaCobro({ sufijo, metodos, metodoInicial, cobro, yaCobrado, modoBcv, tasaBcv, tasaDirecta, onReal }: {
  sufijo: string
  metodos: readonly string[]
  metodoInicial: string
  cobro: ResumenCobro | null
  /** Dólares reales ya cubiertos por el otro método. */
  yaCobrado: number
  modoBcv: boolean
  tasaBcv: number
  tasaDirecta: number
  /** Avisa cuántos dólares reales cubre esta fila. */
  onReal?: (n: number) => void
}) {
  const [metodo, setMetodo] = useState(metodoInicial)
  const [monto, setMonto] = useState('')
  const [dolaresBs, setDolaresBs] = useState<number | null>(null)
  const enBs = cobraEnBolivares(metodo)
  const factor = cobro?.factor ?? 1
  const resto = cobro ? Math.round((cobro.totalReal - yaCobrado) * 100) / 100 : 0
  const sugerido = resto > 0 ? (enBs ? Math.round((resto / factor) * 100) / 100 : resto) : null
  const unidad = !modoBcv ? 'USD' : enBs ? 'USD a tasa BCV' : 'USD en divisas'
  const real = enBs ? (dolaresBs ?? 0) * factor : decimal(monto) || 0
  useEffect(() => onReal?.(real), [real, onReal])

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{sufijo ? 'Otro método' : 'Método de pago'}</label>
        <select name={`metodoPago${sufijo}`} value={metodo} onChange={e => setMetodo(e.target.value)} className={campo}>
          {metodos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {enBs ? (
        <div className="w-48">
          <MontoBs
            key={modoBcv ? 'bcv' : 'directa'}
            sufijo={sufijo}
            onDolares={setDolaresBs}
            etiqueta="Bs recibidos"
            tasaSugerida={modoBcv ? tasaBcv : tasaDirecta}
            etiquetaTasa={modoBcv ? 'Tasa BCV' : 'Tasa de cobro'}
            sugerido={sugerido}
            unidad={unidad}
          />
        </div>
      ) : (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Cobrado ({unidad})</label>
          <input type="number" name={`monto${sufijo}`} min={0.01} step="0.01" value={monto} onChange={e => setMonto(e.target.value)} className={`w-36 font-mono ${campo}`} />
          {sugerido != null && (
            <button type="button" onClick={() => setMonto(sugerido.toFixed(2))} className="block text-[11px] text-blue-600 hover:underline mt-1">
              {sufijo ? 'Cobrar el resto' : 'Cobrar todo'} ({usd(sugerido)})
            </button>
          )}
        </div>
      )}
    </>
  )
}
