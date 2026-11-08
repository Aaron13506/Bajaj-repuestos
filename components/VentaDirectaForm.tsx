'use client'

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import CampoFecha from '@/components/CampoFecha'
import Miniatura from '@/components/Miniatura'
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
  /** Pieza con la que arranca el carrito (el «Vender» del inicio). */
  inicial?: PiezaEnStock | null
}

type Coincidencias = Map<number, { pieceName: string; pieceCode: string }>
const sinCoincidencias: Coincidencias = new Map()

function lineaDe(p: PiezaEnStock, cantidad: number): Linea {
  const cant = Math.max(1, Math.min(cantidad, p.stock))
  return { pieza: p, cantidad: String(cant), precio: p.price.toFixed(2), costo: p.costoUnitUsd != null ? p.costoUnitUsd.toFixed(2) : '' }
}

// "Cobra después": ningún método. No se manda monto y la venta queda por cobrar (igual que con
// el monto vacío); el cobro se registra más tarde desde la venta.
const DESPUES = ''

const usd = (n: number) => `${n < -0.005 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const entero = (s: string) => parseInt(s, 10)
const decimal = (s: string) => parseFloat(s.replace(',', '.'))
const campo = 'h-10 border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const etiqueta = 'flex flex-col gap-1 text-xs font-medium text-gray-600'
const subtitulo = 'text-xs font-semibold text-gray-600 uppercase tracking-wide'

// Vender algo del depósito: se busca igual que en un presupuesto (por moto, por ensamble o por
// pieza), pero solo aparece lo que hay en stock. Sin presupuesto ni caja: se elige el cliente
// —queda a su nombre—, se ve lo que cuestan las piezas y lo que se gana, y se cobra (o se deja
// por cobrar) en el mismo paso. Izquierda: buscar; derecha: la venta, fija mientras se busca.
export default function VentaDirectaForm({ action, clientes, ensambles, motos, metodos, escalon, tasaBcv, tasaDirecta, inicial }: Props) {
  const [modelFilter, setModelFilter] = useState('')
  const [asmSearch, setAsmSearch] = useState('')
  const [selectedNombre, setSelectedNombre] = useState<string | null>(null)
  const [compCache, setCompCache] = useState<Record<string, Componente[]>>({})
  const [cargando, setCargando] = useState(false)
  const [errorPiezas, setErrorPiezas] = useState(false)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [cantidades, setCantidades] = useState<Record<number, number>>({})

  const [lineas, setLineas] = useState<Linea[]>(() => (inicial ? [lineaDe(inicial, 1)] : []))
  const [clienteId, setClienteId] = useState('')
  const [metodo1, setMetodo1] = useState<string>(metodos[0])
  const [metodo2, setMetodo2] = useState<string>(metodos[1] ?? metodos[0])
  const [cobrado1, setCobrado1] = useState(0)
  const [cobrado2, setCobrado2] = useState(0)
  const [segundo, setSegundo] = useState(false)
  const [conVuelto, setConVuelto] = useState(false)
  // Se intentó registrar con algo faltante: desde ahí se muestra qué falta, y se va solo al completarlo.
  const [intento, setIntento] = useState(false)
  const { enviar, isPending, error } = useEnviarAccion(action, () => {})

  // ── Búsqueda: un solo campo ────────────────────────────────────────────────
  // El texto busca a la vez ensambles (por nombre o por el SKU de una pieza de adentro: el
  // cliente llega con el código de la pieza, no con el del ensamble) y las piezas en stock que
  // coinciden, que se agregan directo. Se guarda junto con el término al que contesta, así
  // "buscando" se deriva al renderizar y no se prende y apaga desde el efecto.
  const [piezasHechas, setPiezasHechas] = useState<{ q: string; matches: Coincidencias; piezas: PiezaEnStock[]; error: boolean }>({ q: '', matches: sinCoincidencias, piezas: [], error: false })
  const termino = asmSearch.trim()
  const clave = `${termino}|${modelFilter}`
  const piezasActivo = termino.length >= 2
  const respondida = piezasActivo && piezasHechas.q === clave
  const coincidencias = piezasActivo ? piezasHechas.matches : sinCoincidencias
  const piezasCoinciden = respondida ? piezasHechas.piezas : []
  const buscandoPiezas = piezasActivo && !respondida

  useEffect(() => {
    if (termino.length < 2) return
    let cancelado = false
    const t = setTimeout(async () => {
      let matches: Coincidencias = new Map()
      let piezas: PiezaEnStock[] = []
      let error = false
      try {
        const [rows, enStock] = await Promise.all([searchAssembliesByPiece(termino), buscarEnStock(termino, modelFilter || undefined)])
        matches = new Map(rows.map(r => [r.ensambleId, { pieceName: r.pieceName, pieceCode: r.pieceCode }]))
        piezas = enStock
      } catch {
        error = true
      }
      if (!cancelado) setPiezasHechas({ q: `${termino}|${modelFilter}`, matches, piezas, error })
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
    setErrorPiezas(false)
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
      } catch {
        // Antes el rechazo quedaba sin manejar y la lista se veía vacía, como si no hubiera piezas.
        setErrorPiezas(true)
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
      const i = ls.findIndex(l => l.pieza.id === p.id)
      if (i >= 0) return ls // ya está: se cambia la cantidad en el carrito
      return [...ls, lineaDe(p, cantidad)]
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

  // ── Carrito, totales y cobro ───────────────────────────────────────────────
  const cambiar = (id: number, c: 'cantidad' | 'precio' | 'costo', valor: string) =>
    setLineas(ls => ls.map(l => (l.pieza.id === id ? { ...l, [c]: valor } : l)))

  const parseadas = lineas.map(l => ({
    productId: l.pieza.id,
    quantity: entero(l.cantidad),
    salePrice: decimal(l.precio),
    costoUnitUsd: decimal(l.costo),
  }))
  // El total no necesita el costo: se ve apenas hay cantidades y precios. El margen sí lo espera.
  const preciosOk = lineas.length > 0 && parseadas.every(l => Number.isInteger(l.quantity) && l.quantity > 0 && l.salePrice >= 0)
  const sinCosto = parseadas.filter(l => !(l.costoUnitUsd > 0)).length
  const completas = preciosOk && sinCosto === 0
  const excedeStock = lineas.some(l => entero(l.cantidad) > l.pieza.stock)

  const resumen = completas ? resumenVenta(parseadas) : null
  const cobro = preciosOk
    ? resumenCobro(parseadas.map(l => ({ salePrice: l.salePrice, quantity: l.quantity })), 0, escalon)
    : null

  const modoBcv = escalon != null
  const despues = metodo1 === DESPUES
  // Lo que pagó (dólares reales), lo que falta y lo que pagó de más: el vuelto que se propone.
  const pagado = despues ? 0 : cobrado1 + (segundo ? cobrado2 : 0)
  const sobra = cobro ? Math.max(0, Math.round((pagado - cobro.totalReal) * 100) / 100) : 0
  const faltaReal = cobro ? Math.max(0, Math.round((cobro.totalReal - pagado) * 100) / 100) : 0
  const faltaBcv = cobro && cobro.factor > 0 ? faltaReal / cobro.factor : faltaReal
  const vueltoEnBs = cobraEnBolivares(metodo1) && !segundo
  const camposVuelto = (s: number) => (
    <div className="max-w-64">
      <CamposDevolucion
        key={s.toFixed(2)}
        sugerido={s}
        tasaSugerida={tasaDirecta}
        etiqueta="Vuelto (USD reales)"
        ayuda="Lo que le devolviste porque pagó de más. Puede ser por otro medio que el pago."
      />
    </div>
  )

  const motivo =
    lineas.length === 0 ? 'Agregá al menos una pieza.'
      : excedeStock ? 'Hay una cantidad mayor al stock.'
      : !preciosOk ? 'Revisá cantidad y precio de cada pieza.'
      : sinCosto > 0 ? `Escribí el costo de ${sinCosto === 1 ? 'la pieza que no lo tiene' : `las ${sinCosto} piezas que no lo tienen`}.`
      : clienteId === '' ? 'Elegí un cliente.'
      : null

  // Se valida al registrar, no deshabilitando el botón: así se ve qué falta en vez de un botón muerto.
  function registrar(e: FormEvent<HTMLFormElement>) {
    if (motivo) {
      e.preventDefault()
      setIntento(true)
      return
    }
    enviar(e)
  }

  const motosVisibles = ALL_MODELS.filter(m => motos.includes(m.id))
  const cantMarcadas = Object.values(checked).filter(Boolean).length
  const totalPiezas = parseadas.reduce((s, l) => s + (Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 0), 0)
  const totalVisible = cobro ? (modoBcv ? cobro.totalBcv : cobro.totalReal) : null
  const textoEstado = !piezasActivo
    ? ''
    : buscandoPiezas
      ? 'Buscando…'
      : piezasHechas.error
        ? 'No se pudo buscar. Probá de nuevo.'
        : piezasCoinciden.length === 0 && filas.length === 0
          ? `No tenés en stock nada que coincida con "${termino}".`
          : `${piezasCoinciden.length} ${piezasCoinciden.length === 1 ? 'pieza' : 'piezas'} y ${filas.length} ${filas.length === 1 ? 'ensamble' : 'ensambles'}.`

  return (
    <form
      onSubmit={registrar}
      noValidate
      onKeyDown={e => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault() }}
    >
      <input type="hidden" name="items" value={JSON.stringify(parseadas)} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] gap-6 items-start">
        {/* ── Izquierda: buscar lo que tengo ── */}
        <section aria-labelledby="venta-buscar" className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 space-y-5 min-w-0">
          <h2 id="venta-buscar" className="text-base font-semibold text-gray-900">Buscar en el depósito</h2>

          <div className="grid grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)] gap-3">
            <label className={etiqueta}>
              Moto
              <select
                className={campo}
                value={modelFilter}
                onChange={e => { setModelFilter(e.target.value); setSelectedNombre(null); setChecked({}); setCantidades({}) }}
              >
                <option value="">Todas las motos</option>
                {motosVisibles.map(m => <option key={m.id} value={m.id}>{shortModel(m.id)}</option>)}
              </select>
            </label>
            <label className={etiqueta}>
              Pieza, código o ensamble
              <input
                type="search" value={asmSearch} onChange={e => setAsmSearch(e.target.value)}
                placeholder="Ej.: pastilla, JF191044, pinza…" autoComplete="off"
                className={campo}
              />
            </label>
          </div>
          <p role="status" className={`text-sm min-h-5 ${piezasHechas.error && respondida ? 'text-red-700' : 'text-gray-500'}`}>{textoEstado}</p>

          {piezasCoinciden.length > 0 && (
            <div>
              <h3 className={`${subtitulo} mb-2`}>Piezas en stock · {piezasCoinciden.length}</h3>
              <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {piezasCoinciden.map(p => {
                  const ya = enCarrito(p.id)
                  return (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Miniatura src={p.imageUrl} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 break-words">{p.nameEs}</p>
                        <p className="text-xs text-gray-500 break-words">
                          {p.bajajCode && <span className="font-mono">{p.bajajCode} · </span>}
                          {p.models.length > 0 && <>{formatModels(p.models)} · </>}
                          <span className="font-semibold text-green-800">hay {p.stock}</span>
                        </p>
                      </div>
                      <span className="text-sm text-gray-700 tabular-nums shrink-0">{usd(p.price)}</span>
                      <button
                        type="button" disabled={ya} onClick={() => agregarPieza(p)}
                        className={`shrink-0 min-h-9 w-28 rounded-lg text-sm font-semibold transition-colors ${
                          ya ? 'border border-green-200 bg-green-50 text-green-800' : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        {ya ? '✓ En la venta' : 'Agregar'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {(filas.length > 0 || !piezasActivo) && <div>
            <h3 className={`${subtitulo} mb-2`}>
              {piezasActivo || modelFilter ? 'Ensambles' : 'Ensambles con piezas en el depósito'} · {filas.length}
            </h3>
            {filas.length === 0 ? (
              !piezasActivo && (
                <p className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg px-4 py-6 text-center">
                  {ensambles.length === 0 ? 'No hay ninguna pieza en el depósito.' : 'Ninguno para esa moto.'}
                </p>
              )
            ) : (
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
                          <span className="block text-xs text-gray-500 truncate">
                            tenés {a.piezas.length} {a.piezas.length === 1 ? 'pieza' : 'piezas'} · {formatModels(a.models)}
                          </span>
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
                          {a.ids.length > 1 && (
                            // Juntas, las motos mezclan las piezas: se elige la del cliente y se ve el despiece de esa.
                            <div>
                              <p className="text-xs font-medium text-gray-600 mb-2">¿Para qué moto? Cuántas de tus {a.piezas.length} piezas lleva cada una:</p>
                              <div className="flex flex-wrap gap-2">
                                {ensambles.filter(x => a.ids.includes(x.id)).map(x => {
                                  const moto = x.models[0]
                                  const lleva = new Set(x.piezas.map(p => p.id)).size
                                  return (
                                    <button
                                      key={x.id} type="button"
                                      onClick={() => {
                                        if (!moto) return
                                        setModelFilter(moto)
                                        seleccionar({ ...a, ids: a.ids.filter(id => ensambles.find(e => e.id === id)?.models.includes(moto)) })
                                      }}
                                      className="min-h-8 text-sm px-3 rounded-lg border border-gray-300 hover:border-blue-400 hover:bg-blue-50"
                                    >
                                      {moto ? shortModel(moto) : x.nameEs} <span className="font-semibold text-green-800">· {lleva}</span>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                          {cargando && !componentes ? (
                            <p role="status" className="text-sm text-gray-500 py-4 text-center">Cargando piezas…</p>
                          ) : errorPiezas && !componentes ? (
                            <p role="alert" className="text-sm text-red-700 py-4 text-center">No se pudieron cargar las piezas. Cerrá y volvé a abrir el ensamble.</p>
                          ) : (
                            <fieldset className="space-y-3">
                              <legend className="sr-only">Piezas de {a.nombre} en el depósito</legend>
                              {Array.from(grupos.entries()).map(([nombre, items]) => (
                                <div key={nombre}>
                                  {nombre !== '—' && <p className={`${subtitulo} mb-1`}>{nombre}</p>}
                                  {items.map(c => {
                                    const ya = enCarrito(c.product.id)
                                    return (
                                      <div key={c.id} className="flex items-center gap-3 py-1">
                                        <label className={`flex flex-1 min-w-0 items-center gap-3 min-h-11 ${ya ? 'text-gray-500' : 'cursor-pointer text-gray-900'}`}>
                                          <input
                                            type="checkbox" checked={!!checked[c.id]} disabled={ya}
                                            onChange={e => setChecked(prev => ({ ...prev, [c.id]: e.target.checked }))}
                                            className="size-4 rounded border-gray-300 text-blue-600 shrink-0"
                                          />
                                          <span className="min-w-0 text-sm">
                                            {c.product.nameEs}
                                            {c.product.bajajCode && <> <span className="ml-1 text-xs font-mono text-gray-500">{c.product.bajajCode}</span></>}
                                            {' '}<span className="ml-1 text-xs font-semibold text-green-800">· hay {c.product.stock}</span>
                                            {ya && <> <span className="ml-1 text-xs text-blue-800">· ya en la venta</span></>}
                                            {c.product.models.length > 0 && (
                                              <span className="block text-xs text-gray-500">sirve en {formatModels(c.product.models)}</span>
                                            )}
                                          </span>
                                        </label>
                                        <input
                                          type="number" inputMode="numeric" min={1} max={c.product.stock} value={cantidades[c.id] ?? 1}
                                          onChange={e => setCantidades(prev => ({ ...prev, [c.id]: Math.min(parseInt(e.target.value) || 1, c.product.stock) }))}
                                          disabled={!checked[c.id] || ya}
                                          aria-label={`Cantidad de ${c.product.nameEs}`}
                                          className="h-9 w-16 border border-gray-300 rounded-lg px-2 text-sm text-center tabular-nums disabled:opacity-40"
                                        />
                                        <span className="text-sm text-gray-700 w-16 text-right tabular-nums">{usd(c.product.price)}</span>
                                      </div>
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
                            {cantMarcadas === 0 ? 'Marcá las piezas que se lleva' : `Agregar ${cantMarcadas} ${cantMarcadas === 1 ? 'marcada' : 'marcadas'}`}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>}
        </section>

        {/* ── Derecha: la venta. Fija en pantalla grande mientras se busca a la izquierda. ── */}
        <aside aria-labelledby="venta-ticket" className="bg-white rounded-xl border border-gray-200 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto divide-y divide-gray-100 min-w-0">
          <div className="p-4 sm:p-5 space-y-3">
            <h2 id="venta-ticket" className="text-base font-semibold text-gray-900">La venta</h2>
            <label className={etiqueta}>
              <span>Cliente <span className="text-red-700" aria-hidden="true">*</span><span className="sr-only">(obligatorio)</span></span>
              <select name="clienteId" value={clienteId} onChange={e => setClienteId(e.target.value)} required className={campo}>
                <option value="">Elegí un cliente…</option>
                {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                <option value="__new__">+ Cliente nuevo</option>
              </select>
            </label>
            {clienteId === '__new__' && (
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_9rem] gap-3">
                <label className={etiqueta}>
                  Nombre
                  <input type="text" name="nuevoClienteNombre" required autoComplete="off" className={campo} />
                </label>
                <label className={etiqueta}>
                  Teléfono (opcional)
                  <input type="tel" name="nuevoClienteTelefono" autoComplete="off" className={campo} />
                </label>
              </div>
            )}
            <label className={etiqueta}>
              Nota (opcional)
              <input type="text" name="notas" autoComplete="off" className={campo} />
            </label>
            <p className="text-xs text-gray-500">La venta queda a su nombre en su ficha de cliente.</p>
          </div>

          <div className="p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">
              Lo que se lleva
              {lineas.length > 0 && <span className="ml-1 font-normal text-gray-500">· {totalPiezas} {totalPiezas === 1 ? 'pieza' : 'piezas'}</span>}
            </h3>
            {lineas.length === 0 ? (
              <p className="text-sm text-gray-500 text-center border border-dashed border-gray-300 rounded-lg px-4 py-6">
                Buscá en el depósito lo que se lleva el cliente y tocá <strong className="font-semibold">Agregar</strong>.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {lineas.map(l => {
                  const cant = entero(l.cantidad)
                  const subtotal = cant > 0 ? cant * decimal(l.precio) : NaN
                  const faltaCosto = !(decimal(l.costo) > 0)
                  const sinCostoCargado = l.pieza.costoUnitUsd == null
                  return (
                    <li key={l.pieza.id} className="py-3 first:pt-0 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 break-words">{l.pieza.nameEs}</p>
                          <p className="text-xs text-gray-500">
                            <span className="font-mono">{l.pieza.bajajCode ?? 'sin código'}</span> · hay {l.pieza.stock}
                            {cant > l.pieza.stock && <span className="text-red-700 font-semibold"> · no alcanza el stock</span>}
                          </p>
                        </div>
                        <button
                          type="button" onClick={() => setLineas(ls => ls.filter(x => x.pieza.id !== l.pieza.id))}
                          aria-label={`Quitar ${l.pieza.nameEs}`}
                          className="size-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-red-700 hover:bg-red-50"
                        >
                          <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-0.5 text-[11px] font-medium text-gray-600">
                          Cant.
                          <input type="number" inputMode="numeric" min={1} max={l.pieza.stock} step={1} value={l.cantidad} onChange={e => cambiar(l.pieza.id, 'cantidad', e.target.value)} aria-invalid={cant > l.pieza.stock || undefined} className={`h-9 w-16 border rounded-lg px-2 text-base sm:text-sm tabular-nums ${cant > l.pieza.stock ? 'border-red-500' : 'border-gray-300'}`} />
                        </label>
                        <label className="flex flex-col gap-0.5 text-[11px] font-medium text-gray-600">
                          Precio $
                          <input type="number" inputMode="decimal" min={0} step="0.01" value={l.precio} onChange={e => cambiar(l.pieza.id, 'precio', e.target.value)} className="h-9 w-24 border border-gray-300 rounded-lg px-2 text-base sm:text-sm tabular-nums" />
                        </label>
                        <label className={`flex flex-col gap-0.5 text-[11px] font-medium ${sinCostoCargado ? 'text-amber-900' : 'text-gray-600'}`}>
                          {sinCostoCargado ? 'Costo $ (no tenía)' : 'Costo $'}
                          <input
                            type="number" inputMode="decimal" min={0.01} step="0.01" value={l.costo} onChange={e => cambiar(l.pieza.id, 'costo', e.target.value)}
                            aria-invalid={faltaCosto || undefined}
                            className={`h-9 w-24 border rounded-lg px-2 text-base sm:text-sm tabular-nums ${sinCostoCargado ? 'border-amber-500 bg-amber-50' : 'border-gray-300'}`}
                          />
                        </label>
                        <span className="ml-auto pb-2 text-sm font-semibold text-gray-900 tabular-nums">{Number.isFinite(subtotal) ? usd(subtotal) : '—'}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {cobro && (
              <div className="mt-3 pt-3 border-t border-gray-200 space-y-1 tabular-nums">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-gray-700">{modoBcv ? 'Total a tasa BCV' : 'Total'}</span>
                  <span className="text-2xl font-bold text-gray-900">{usd(totalVisible!)}</span>
                </div>
                {modoBcv && (
                  <div className="flex justify-between text-sm text-gray-500"><span>En divisas</span><span>{usd(cobro.totalReal)}</span></div>
                )}
                <div className="flex justify-between gap-2 text-sm text-gray-500">
                  {resumen ? (
                    <>
                      <span>Costo {usd(resumen.costoUsd)} · ganás</span>
                      <span className={`font-semibold ${resumen.margenUsd >= 0 ? 'text-green-800' : 'text-red-700'}`}>
                        {usd(resumen.margenUsd)} ({resumen.margenPct.toFixed(1)}%)
                      </span>
                    </>
                  ) : (
                    <span className="text-amber-900">Lo que ganás aparece cuando escribas el costo que falta.</span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="p-4 sm:p-5 space-y-3">
            <fieldset>
              <legend className="text-sm font-semibold text-gray-700 mb-2">Cobro</legend>
              <Opciones
                name="metodoPago"
                opciones={[...metodos.map(m => ({ valor: m, texto: m })), { valor: DESPUES, texto: 'Cobra después' }]}
                valor={metodo1}
                onChange={m => { setMetodo1(m); if (m === DESPUES) { setSegundo(false); setConVuelto(false) } }}
              />
            </fieldset>

            {despues ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {cobro ? <>Queda todo por cobrar: <strong className="tabular-nums">{usd(totalVisible!)}</strong>{modoBcv && ' a tasa BCV'}.</> : 'Queda todo por cobrar.'}{' '}
                Lo registrás después desde la venta.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-start gap-3">
                  <FilaCobro
                    sufijo="" metodo={metodo1} cobro={cobro} yaCobrado={0}
                    modoBcv={modoBcv} tasaBcv={tasaBcv} tasaDirecta={tasaDirecta} onReal={setCobrado1}
                    vuelto={vueltoEnBs ? camposVuelto : undefined}
                  />
                  <label className={etiqueta}>
                    Fecha
                    <CampoFecha name="fecha" className={campo} />
                  </label>
                </div>
                {segundo ? (
                  <div className="space-y-3 border-t border-gray-100 pt-3">
                    <fieldset>
                      <legend className="text-xs font-medium text-gray-600 mb-2">Otro método</legend>
                      <Opciones name="metodoPago2" opciones={metodos.map(m => ({ valor: m, texto: m }))} valor={metodo2} onChange={setMetodo2} />
                    </fieldset>
                    <div className="flex flex-wrap items-end gap-3">
                      <FilaCobro
                        sufijo="2" metodo={metodo2} cobro={cobro} yaCobrado={cobrado1}
                        modoBcv={modoBcv} tasaBcv={tasaBcv} tasaDirecta={tasaDirecta} onReal={setCobrado2}
                      />
                      <button type="button" onClick={() => setSegundo(false)} className="min-h-10 px-2 text-sm text-gray-600 hover:text-red-700 hover:underline">
                        Quitar este método
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setSegundo(true)} className="min-h-9 text-sm text-blue-700 hover:underline">
                    + Pagó una parte con otro método
                  </button>
                )}
                {/* Un solo cobro en Bs: el vuelto es una opción de "¿qué hacemos con lo que sobra?". */}
                {!vueltoEnBs && <div className="space-y-2">
                  <label className="inline-flex items-center gap-2 min-h-9 text-sm text-gray-700">
                    <input type="checkbox" checked={conVuelto} onChange={e => setConVuelto(e.target.checked)} className="size-4 rounded border-gray-300" />
                    Le di vuelto{sobra > 0 && <span className="text-gray-500 tabular-nums"> (pagó {usd(sobra)} de más)</span>}
                  </label>
                  {conVuelto && camposVuelto(sobra)}
                </div>}
                {/* Un solo cobro en Bs: MontoBs ya pregunta qué pasa con lo que falta. */}
                {cobro && faltaReal > 0.005 && !(cobraEnBolivares(metodo1) && !segundo && pagado > 0.005) && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    {pagado > 0.005 ? 'Quedan' : 'Sin monto: quedan'} <strong className="tabular-nums">{usd(faltaBcv)}</strong>
                    {modoBcv && ' a tasa BCV'} por cobrar. Lo registrás después desde la venta.
                  </p>
                )}
              </>
            )}

            <div className="hidden lg:block space-y-2">
              <BotonRegistrar isPending={isPending} className="w-full" />
            </div>
            <Avisos aviso={intento ? motivo : null} error={error} />
          </div>
        </aside>
      </div>

      {/* Teléfono y tablet: el total y el botón siempre a mano, pegados abajo mientras se llena. */}
      <div className="lg:hidden sticky bottom-3 z-10 mt-4 rounded-xl bg-white border border-gray-200 shadow-lg px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0 tabular-nums">
            <p className="text-xs text-gray-500">Total · {totalPiezas} {totalPiezas === 1 ? 'pieza' : 'piezas'}</p>
            <p className="text-xl font-bold text-gray-900">
              {totalVisible != null ? usd(totalVisible) : '—'}
              {totalVisible != null && modoBcv && <span className="ml-1 text-xs font-semibold text-gray-500">BCV</span>}
            </p>
          </div>
          <BotonRegistrar isPending={isPending} />
        </div>
      </div>
    </form>
  )
}

function BotonRegistrar({ isPending, className = '' }: { isPending: boolean; className?: string }) {
  return (
    <button
      type="submit" disabled={isPending}
      className={`min-h-12 px-5 rounded-lg bg-blue-600 text-white text-base font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors ${className}`}
    >
      {isPending ? 'Registrando…' : 'Registrar venta'}
    </button>
  )
}

// Lo que falta para registrar y el error del servidor, junto al botón. La región está montada
// siempre (vacía) para que el lector de pantalla anuncie el texto cuando aparece.
function Avisos({ aviso, error }: { aviso: string | null; error: string | null }) {
  return (
    <div role="alert" className="text-sm text-red-700">
      {aviso ?? error}
    </div>
  )
}

// Opciones de radio con forma de botón: el método de pago a un toque.
function Opciones({ name, opciones, valor, onChange }: {
  name: string
  opciones: { valor: string; texto: string }[]
  valor: string
  onChange: (v: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {opciones.map(o => (
        <label key={o.valor || 'despues'} className="relative">
          <input
            type="radio" name={name} value={o.valor} checked={valor === o.valor} onChange={() => onChange(o.valor)}
            className="peer sr-only"
          />
          <span className="flex min-h-11 items-center justify-center rounded-lg border border-gray-300 px-2 py-1.5 text-center text-sm text-gray-700 cursor-pointer hover:bg-gray-50 peer-checked:border-2 peer-checked:border-blue-600 peer-checked:bg-blue-50 peer-checked:font-semibold peer-checked:text-blue-800 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2">
            {o.texto}
          </span>
        </label>
      ))}
    </div>
  )
}

// Un cobro de la venta: el monto del método elegido. Con `sufijo` '2' es el segundo método del
// mismo pago (parte en Bs, parte en efectivo); su sugerido es lo que falta después del primero.
function FilaCobro({ sufijo, metodo, cobro, yaCobrado, modoBcv, tasaBcv, tasaDirecta, onReal, vuelto }: {
  sufijo: string
  metodo: string
  cobro: ResumenCobro | null
  /** Dólares reales ya cubiertos por el otro método. */
  yaCobrado: number
  modoBcv: boolean
  tasaBcv: number
  tasaDirecta: number
  /** Avisa cuántos dólares reales cubre esta fila. */
  onReal?: (n: number) => void
  /** Campos del vuelto, dados los dólares reales que sobran: en Bs es una opción de la calculadora. */
  vuelto?: (sobraReal: number) => ReactNode
}) {
  const [monto, setMonto] = useState('')
  const [dolaresBs, setDolaresBs] = useState<number | null>(null)
  const enBs = cobraEnBolivares(metodo)
  const factor = cobro?.factor ?? 1
  const resto = cobro ? Math.round((cobro.totalReal - yaCobrado) * 100) / 100 : 0
  const sugerido = resto > 0 ? (enBs ? Math.round((resto / factor) * 100) / 100 : resto) : null
  const unidad = !modoBcv ? 'USD' : enBs ? 'USD a tasa BCV' : 'USD en divisas'
  const real = enBs ? (dolaresBs ?? 0) * factor : decimal(monto) || 0
  useEffect(() => onReal?.(real), [real, onReal])

  return enBs ? (
    <div className="w-full">
      <MontoBs
        key={modoBcv ? 'bcv' : 'directa'}
        sufijo={sufijo}
        onDolares={setDolaresBs}
        etiqueta="Bs recibidos"
        tasaSugerida={modoBcv ? tasaBcv : tasaDirecta}
        etiquetaTasa={modoBcv ? 'Tasa BCV' : 'Tasa de cobro'}
        sugerido={sugerido}
        cierra
        unidad={unidad}
        vuelto={vuelto && (s => vuelto(Math.floor(s * factor * 100) / 100))}
      />
    </div>
  ) : (
    <div>
      <label htmlFor={`venta-monto${sufijo}`} className="block text-xs font-medium text-gray-600 mb-1">Cobrado ({unidad})</label>
      <input id={`venta-monto${sufijo}`} type="number" inputMode="decimal" name={`monto${sufijo}`} min={0.01} step="0.01" value={monto} onChange={e => setMonto(e.target.value)} className={`w-36 tabular-nums ${campo}`} />
      {sugerido != null && (
        <button type="button" onClick={() => setMonto(sugerido.toFixed(2))} className="block min-h-8 text-sm text-blue-700 hover:underline">
          {sufijo ? 'Cobrar el resto' : 'Cobrar todo'} ({usd(sugerido)})
        </button>
      )}
    </div>
  )
}
