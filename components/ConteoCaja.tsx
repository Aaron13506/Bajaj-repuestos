'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { limpiarNombre } from '@/lib/utils'
import { coincideParcial } from '@/lib/conteo'
import { DECISION_LABEL, puedeCerrar, type Decision } from '@/lib/recepcion'
import type { OrigenLectura } from '@/lib/qr-bajaj'
import type { ResultadoLectura, VistaRecepcion, FilaVista } from '@/lib/recepcion-db'
import {
  anotarEnRecepcion, cerrarEnRecepcion, ciegoEnRecepcion, corregirFila, deshacerEnRecepcion, identificarFila,
  leerEnRecepcion, sinIdentificarEnRecepcion,
} from '@/app/(pages)/envios/recepcion-actions'
import { medirPieza } from '@/app/(pages)/products/actions'
import FormConResultado from './FormConResultado'
import PendingButton from './PendingButton'
import { senal, type Senal } from './senal'

// Su portal necesita `document`: no se renderiza en el servidor.
const LectorCamara = dynamic(() => import('./LectorCamara'), { ssr: false })

export interface Estimada { productId: number; weightGrams: number | null; dimL: number | null; dimA: number | null; dimH: number | null }

type Aviso =
  | { tono: Senal; texto: string; lecturaId?: number; bolsa?: { lineaId: number; cantidad: number; contado: number }; ofrecer?: { raw: string; origen: OrigenLectura; crear: string | null } }
  | { tono: 'varias'; filas: { lineaId: number; codigo: string | null; nombre: string }[] }

// Una etiqueta de caja o bolsa (SKU-cantidad-MRP) la mandó un lector; lo tecleado a mano no la trae.
const origenTecleado = (raw: string): OrigenLectura => (/^[A-Z0-9]+[^A-Z0-9]+\d+[^A-Z0-9]/i.test(raw.trim()) ? 'lector' : 'manual')

// El conteo de una recepción abierta (docs/plan-inventario/03-recepcion.md y 07-casos-telefono.md).
// El mismo en la laptop (pestaña Llegada de la caja) y en el teléfono (/escanear/recepcion/[id]):
// cada lectura va al servidor (lib/recepcion-db) y la pantalla pinta lo que contestó, así nunca
// muestra un número que la base no tiene. Cada lectura suma lo que trae la etiqueta (-2 suma 2).
export default function ConteoCaja({ vista, volver, telefono = false, estimadas, refrescar = false }: {
  vista: VistaRecepcion
  /** A dónde vuelve "Crear pieza" después de guardarla. */
  volver: string
  telefono?: boolean
  /** Laptop: piezas con peso y medidas estimados, por código, para ofrecer pesarlas. */
  estimadas?: Record<string, Estimada>
  /** La laptop refresca cada 3 s para ver lo que cuenta el teléfono. */
  refrescar?: boolean
}) {
  const router = useRouter()
  const r = vista
  const maritimo = r.envio.modo === 'maritimo_cbm'
  // Lo que contestó el servidor gana sobre la vista hasta que un refresco trae lo mismo.
  const [contados, setContados] = useState<Record<number, number | null>>({})
  const [base, setBase] = useState(r.lineas)
  if (base !== r.lineas) {
    setBase(r.lineas)
    setContados(c => Object.fromEntries(Object.entries(c).filter(([id, v]) => r.lineas.find(l => l.id === Number(id))?.contado !== v)))
  }
  const filas = r.lineas.map(l => (l.id in contados ? { ...l, contado: contados[l.id] } : l))
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [texto, setTexto] = useState('')
  const [camara, setCamara] = useState(telefono)
  const [corrigiendo, setCorrigiendo] = useState(false)
  const [sinId, setSinId] = useState<{ nota: string; cantidad: string } | null>(null)
  const [decisiones, setDecisiones] = useState<Record<number, Decision>>({})
  const [error, setError] = useState<string | null>(null)
  const [cerrando, setCerrando] = useState(false)
  const [aMedir, setAMedir] = useState<string | null>(null)
  const [noMedir, setNoMedir] = useState<Set<string>>(new Set())
  const enVuelo = useRef(0)

  useEffect(() => {
    if (!refrescar) return
    const t = setInterval(() => { if (document.visibilityState === 'visible' && enVuelo.current === 0) router.refresh() }, 3000)
    return () => clearInterval(t)
  }, [refrescar, router])

  const ciego = r.ciego
  const marca = (contado: number, esperado: number) => (ciego ? `${contado}` : `${contado} de ${esperado}`)
  const fijar = (lineaId: number, contado: number | null) => setContados(c => ({ ...c, [lineaId]: contado }))

  function errorDe(res: { error: string; codigo?: string }): Senal {
    setAviso({ tono: 'error', texto: res.error })
    if (res.codigo === 'cerrada') router.refresh()
    return 'error'
  }

  function pintar(res: ResultadoLectura, raw: string, origen: OrigenLectura): Senal {
    if (res.tipo === 'varias') { setAviso({ tono: 'varias', filas: res.filas }); return 'error' }
    if (res.tipo === 'no_esperada') {
      setAviso({ tono: 'error', texto: `${res.codigo} · ${limpiarNombre(res.nombre)} no viene en esta caja`, ofrecer: { raw, origen, crear: null } })
      return 'error'
    }
    if (res.tipo === 'fuera_catalogo') {
      setAviso({ tono: 'error', texto: `${res.codigo} no está en el catálogo`, ofrecer: { raw, origen, crear: res.codigo } })
      return 'error'
    }
    fijar(res.lineaId, res.contado)
    const bolsa = res.cantidad > 1
    const sobran = res.esperado > 0 ? res.contado - res.esperado : 0
    const tono: Senal = bolsa ? 'bolsa' : 'ok'
    setAviso({
      tono,
      texto: `+${res.cantidad}${bolsa ? ' bolsa' : ''} ${res.codigo ?? ''} · ${limpiarNombre(res.nombre)} → ${res.esperado === 0 ? `${res.contado} (no esperada)` : marca(res.contado, res.esperado)}` +
        (!ciego && sobran > 0 ? ` · sobran ${sobran}` : '') + (res.leidoComo ? ` · leído como ${res.leidoComo}` : ''),
      lecturaId: res.lecturaId,
      bolsa: bolsa ? { lineaId: res.lineaId, cantidad: res.cantidad, contado: res.contado } : undefined,
    })
    if (res.codigo && estimadas?.[res.codigo] && !noMedir.has(res.codigo)) setAMedir(res.codigo)
    return tono
  }

  // Cada acción espera al servidor: la pantalla solo suma lo que quedó guardado.
  async function correr(pedir: () => Promise<{ ok: true; r: ResultadoLectura } | { ok: false; error: string; codigo?: string }>, raw: string, origen: OrigenLectura, estructural = false): Promise<Senal> {
    enVuelo.current++
    setCorrigiendo(false)
    let tono: Senal = 'error'
    try {
      const res = await pedir()
      tono = res.ok ? pintar(res.r, raw, origen) : errorDe(res)
      if (res.ok && res.r.tipo === 'sumo') setTexto('')
      if (res.ok && estructural) router.refresh()
    } catch {
      setAviso({ tono: 'error', texto: 'No se guardó: revisá la señal y reintentá.' })
    }
    enVuelo.current--
    senal(tono)
    return tono
  }

  const leer = (raw: string, origen: OrigenLectura) => {
    if (!raw.trim()) { senal('error'); setAviso({ tono: 'error', texto: 'No se leyó ninguna etiqueta.' }); return 'error' as Senal }
    return correr(() => leerEnRecepcion(r.id, raw, origen), raw, origen)
  }

  async function simple<T>(accion: () => Promise<{ ok: true; r?: T } | { ok: false; error: string; codigo?: string }>, despues?: (r: T) => void, refrescarDespues = false) {
    enVuelo.current++
    try {
      const res = await accion()
      if (!res.ok) errorDe(res)
      else {
        if (despues) despues(res.r as T)
        if (refrescarDespues) router.refresh()
      }
    } catch {
      setAviso({ tono: 'error', texto: 'No se guardó: revisá la señal y reintentá.' })
    }
    enVuelo.current--
  }

  const corregir = (f: FilaVista, total: number) => {
    if (!Number.isInteger(total) || total < 0 || total === f.contado) return
    void simple(() => corregirFila(f.id, total), res => {
      fijar(f.id, res.contado)
      setAviso({ tono: 'ok', texto: `${f.codigo ?? limpiarNombre(f.nombre)} → ${f.esperado > 0 ? marca(res.contado, f.esperado) : res.contado}` })
    })
  }

  const visibles = texto.trim() ? filas.filter(f => coincideParcial({ clave: String(f.id), nombre: f.nombre, codigo: f.codigo, alternos: f.alternos }, texto)) : filas
  const contadas = filas.filter(f => f.contado != null).length
  const conDecision = filas.map(f => ({ ...f, decision: f.contado != null && f.contado < f.esperado ? decisiones[f.id] ?? f.decision : null }))
  const motivo = puedeCerrar(conDecision)
  const diferencias = conDecision.filter(f => f.contado != null && f.contado !== f.esperado)
  const crearHref = (codigo: string) => `/products/new?sku=${encodeURIComponent(codigo)}&volver=${encodeURIComponent(volver)}`
  const medible = aMedir && estimadas?.[aMedir] ? { codigo: aMedir, ...estimadas[aMedir] } : null
  const boton = telefono ? 'min-h-11 px-4 text-base' : 'min-h-9 px-3 text-sm'

  const avisoVista = aviso && (
    <div role="status" aria-live="polite">
      {aviso.tono === 'varias' ? (
        <div className="space-y-2">
          <p className="font-medium text-amber-800">{aviso.filas.length} filas coinciden: elegí cuál sumar.</p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {aviso.filas.map(f => (
              <li key={f.lineaId}>
                <button type="button" onClick={() => void correr(() => leerEnRecepcion(r.id, '', 'manual', f.lineaId), '', 'manual')} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
                  <span className="font-mono text-sm text-gray-600">{f.codigo ?? '—'}</span>
                  <span className="flex-1 text-gray-900">{limpiarNombre(f.nombre)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 ${aviso.tono === 'ok' ? 'bg-green-50 text-green-900' : aviso.tono === 'bolsa' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'}`}>
          <p className={`flex-1 font-semibold ${telefono ? 'text-lg' : 'text-sm'}`}>{aviso.texto}</p>
          {aviso.bolsa && !corrigiendo && (
            <button type="button" onClick={() => setCorrigiendo(true)} className={`${boton} rounded-lg border border-amber-500 font-semibold`}>Corregir</button>
          )}
          {aviso.bolsa && corrigiendo && (
            <form
              onSubmit={e => {
                e.preventDefault()
                const n = Number(new FormData(e.currentTarget).get('n'))
                const b = aviso.bolsa!
                if (Number.isInteger(n) && n >= 0) void simple(() => corregirFila(b.lineaId, b.contado - b.cantidad + n), res => {
                  fijar(b.lineaId, res.contado)
                  setAviso({ tono: 'ok', texto: `Corregido: la bolsa traía ${n} → ${res.contado}` })
                })
                setCorrigiendo(false)
              }}
              className="flex items-center gap-1"
            >
              <label className="flex items-center gap-1 text-sm">
                La bolsa traía
                <input name="n" type="number" min={0} step={1} required autoFocus inputMode="numeric" defaultValue={aviso.bolsa.cantidad} className="min-h-9 w-16 rounded-md border border-gray-300 px-2 text-right font-mono" />
              </label>
              <button className={`${boton} rounded-lg bg-amber-600 font-semibold text-white`}>Listo</button>
            </form>
          )}
          {aviso.ofrecer && (
            <>
              <button type="button" onClick={() => void correr(() => anotarEnRecepcion(r.id, aviso.ofrecer!.raw, aviso.ofrecer!.origen), aviso.ofrecer!.raw, aviso.ofrecer!.origen, true)} className={`${boton} rounded-lg border border-red-300 font-semibold`}>
                {aviso.ofrecer.crear ? 'Anotar' : 'Anotar como no esperada'}
              </button>
              {aviso.ofrecer.crear && <Link href={crearHref(aviso.ofrecer.crear)} className={`${boton} inline-flex items-center rounded-lg border border-red-300 font-semibold`}>Crear pieza</Link>}
              <button type="button" onClick={() => setAviso(null)} className={`${boton} rounded-lg underline`}>Ignorar</button>
            </>
          )}
          {aviso.lecturaId != null && (
            <button
              type="button"
              onClick={() => { const id = aviso.lecturaId!; void simple(() => deshacerEnRecepcion(id), res => { fijar(res.lineaId, res.contado); setAviso({ tono: 'ok', texto: 'Deshecho.' }) }) }}
              className={`${boton} rounded-lg font-semibold underline`}
            >
              Deshacer
            </button>
          )}
        </div>
      )}
      {medible && (
        <FormConResultado
          key={medible.codigo}
          action={medirPieza.bind(null, medible.productId)}
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
        >
          <span className="text-amber-900"><span className="font-semibold">{medible.codigo}</span> tiene peso y medidas estimados. ¿La medís ahora? (con su bolsa o caja)</span>
          {([['weightGrams', 'g', medible.weightGrams], ['dimL', 'L cm', medible.dimL], ['dimA', 'A cm', medible.dimA], ['dimH', 'H cm', medible.dimH]] as const).map(([name, label, est]) => (
            <label key={name} className="flex items-center gap-1 text-gray-600">
              {label}
              <input name={name} type="number" min={0} step="any" required placeholder={est != null ? String(est) : ''} className="w-16 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-right font-mono" />
            </label>
          ))}
          <PendingButton pendingLabel="Guardando…" className="rounded bg-amber-600 px-2.5 py-1 font-semibold text-white hover:bg-amber-700 disabled:opacity-50">Guardar medida</PendingButton>
          <button type="button" onClick={() => { setNoMedir(s => new Set(s).add(medible.codigo)); setAMedir(null) }} className="text-gray-600 underline">Ahora no</button>
        </FormConResultado>
      )}
    </div>
  )

  const panel = (
    <div className="space-y-3">
      {avisoVista}
      <form role="search" className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (texto.trim()) void leer(texto, origenTecleado(texto)) }}>
        <input
          type="search"
          value={texto}
          onChange={e => setTexto(e.target.value)}
          autoFocus={!telefono}
          enterKeyHint="go"
          autoComplete="off"
          aria-label="Código, parte del código o nombre"
          placeholder="Escaneá o tecleá el código (o parte) + Enter"
          className={`min-w-0 flex-1 rounded-lg border border-gray-300 px-3 font-mono ${telefono ? 'min-h-11 text-base' : 'min-h-9 text-sm'}`}
        />
        <button type="submit" className={`${boton} rounded-lg bg-blue-600 font-semibold text-white`}>Sumar</button>
        {!camara && <button type="button" onClick={() => setCamara(true)} className={`${boton} rounded-lg bg-gray-900 font-semibold text-white`}>Cámara</button>}
        <button type="button" onClick={() => setSinId({ nota: '', cantidad: '1' })} className={`${boton} rounded-lg border border-gray-300 text-gray-700`}>Sin identificar</button>
      </form>
      {sinId && (
        <form
          onSubmit={e => {
            e.preventDefault()
            void simple(() => sinIdentificarEnRecepcion(r.id, sinId.nota, Number(sinId.cantidad)), () => setSinId(null), true)
          }}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <input value={sinId.nota} onChange={e => setSinId({ ...sinId, nota: e.target.value })} autoFocus required placeholder="Qué es: bolsa con 6 tornillos, sin etiqueta…" aria-label="Nota de la pieza sin identificar" className="min-h-9 min-w-48 flex-1 rounded-lg border border-gray-300 px-3" />
          <input value={sinId.cantidad} onChange={e => setSinId({ ...sinId, cantidad: e.target.value })} type="number" min={1} step={1} inputMode="numeric" required aria-label="Cuántas" className="min-h-9 w-16 rounded-lg border border-gray-300 px-2 text-right" />
          <button className={`${boton} rounded-lg bg-gray-900 font-semibold text-white`}>Anotar</button>
          <button type="button" onClick={() => setSinId(null)} className={`${boton} rounded-lg text-gray-700`}>Cancelar</button>
        </form>
      )}
      <p className="text-sm text-gray-600">
        {contadas} de {filas.length} {filas.length === 1 ? 'código contado' : 'códigos contados'}
        {ciego && ' · conteo ciego: lo esperado aparece al contar cada fila'}
      </p>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {visibles.map(f => <FilaConteo key={f.id} f={f} ciego={ciego} telefono={telefono} corregir={corregir} crearHref={crearHref}
          identificar={(raw) => void simple(() => identificarFila(f.id, raw), undefined, true)} />)}
        {visibles.length === 0 && <li className="px-3 py-4 text-sm text-gray-600">Ninguna fila coincide con «{texto}». Enter la suma como lectura.</li>}
      </ul>

      {/* Cierre: lo que no coincide y, en cada faltante, qué se hace con el resto. */}
      <section aria-labelledby={`cierre-${r.id}`} className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
        <h3 id={`cierre-${r.id}`} className="font-semibold text-gray-900">Cerrar la recepción</h3>
        {diferencias.length === 0
          ? <p className="text-sm text-gray-600">{contadas === filas.length ? 'Todo coincide con lo esperado.' : 'Las diferencias aparecen acá a medida que contás.'}</p>
          : (
            <ul className="space-y-2 text-sm">
              {diferencias.map(f => {
                const dif = f.contado! - f.esperado
                return (
                  <li key={f.id} className="space-y-1">
                    <p><span className="font-mono">{f.codigo ?? 'sin identificar'}</span> · {limpiarNombre(f.nombre)}: llegaron {f.contado} de {f.esperado} {dif > 0 ? <span className="font-semibold text-amber-800">({f.productId == null ? `${dif} sin pieza del catálogo: frena el cierre` : `sobran ${dif}: entran al stock a $0`})</span> : <span className="font-semibold text-red-700">(faltan {-dif})</span>}</p>
                    {dif < 0 && (
                      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                        <legend className="sr-only">¿Esperás el resto de {f.codigo ?? f.nombre}?</legend>
                        {(maritimo ? (['backorder', 'faltante'] as const) : (['backorder', 'faltante', 'equivocada'] as const)).map(d => (
                          <label key={d} className="flex min-h-9 items-center gap-1.5">
                            <input type="radio" name={`decision-${f.id}`} checked={f.decision === d} onChange={() => setDecisiones(x => ({ ...x, [f.id]: d }))} />
                            {d === 'backorder' ? 'Sí, llega después' : d === 'faltante' ? 'No, es faltante' : DECISION_LABEL.equivocada}
                          </label>
                        ))}
                      </fieldset>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={motivo != null || cerrando}
            onClick={async () => {
              setCerrando(true)
              setError(null)
              try {
                const res = await cerrarEnRecepcion(r.id, r.envioId, decisiones)
                if (!res.ok) setError(res.error)
                router.refresh()
              } catch {
                setError('No se pudo cerrar: revisá la señal y reintentá.')
              }
              setCerrando(false)
            }}
            className={`${boton} rounded-lg bg-emerald-700 font-semibold text-white disabled:opacity-40`}
          >
            {cerrando ? 'Cerrando…' : 'Cerrar recepción'}
          </button>
          {motivo && <p className="text-sm text-gray-600">{motivo}</p>}
        </div>
        <p className="text-xs text-gray-600">
          {maritimo
            ? 'Al cerrar entra al stock lo contado, al costo de la caja. Una recepción cerrada no se edita: se revierte entera.'
            : 'Al cerrar, lo de clientes pasa a Recibido y lo propio entra al stock por lo contado; cada faltante deja su incidencia en el pedido. Una recepción cerrada no se edita: se revierte entera.'}
        </p>
      </section>
      {!telefono && (
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={ciego} onChange={e => void simple(() => ciegoEnRecepcion(r.id, r.envioId, e.target.checked))} />
          Conteo ciego (no mostrar lo esperado hasta contar cada fila)
        </label>
      )}
    </div>
  )

  return camara
    ? (
      <LectorCamara onLectura={raw => leer(raw, 'camara')} onCerrar={() => setCamara(false)}>
        {panel}
      </LectorCamara>
    )
    : panel
}

// Una fila de la mesa: + / − y la cantidad editable. En ciego, sin lo esperado ni "llegó todo"
// hasta que la fila tiene conteo. Una fila sin pieza del catálogo ofrece crearla, asignarla o descartarla.
function FilaConteo({ f, ciego, telefono, corregir, crearHref, identificar }: {
  f: FilaVista
  ciego: boolean
  telefono: boolean
  corregir: (f: FilaVista, total: number) => void
  crearHref: (codigo: string) => string
  identificar: (raw: string) => void
}) {
  const [asignando, setAsignando] = useState(false)
  const n = f.contado
  const ver = !ciego || n != null
  const dif = n == null ? null : n - f.esperado
  const btn = telefono ? 'min-h-11 min-w-11 text-lg' : 'min-h-8 min-w-8 text-sm'
  const nombre = f.codigo ?? f.nombre
  return (
    <li className={`px-3 py-2 ${dif != null && dif !== 0 && ver ? 'bg-red-50/60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-gray-900">{f.codigo == null ? <><span className="font-semibold">Sin identificar:</span> {f.nombre}</> : limpiarNombre(f.nombre)}</p>
          <p className="font-mono text-sm text-gray-600">
            {f.codigo ?? '—'}
            {ver && f.esperado > 0 && <span className="font-sans"> · esperado {f.esperado}</span>}
            {f.esperado === 0 && <span className="font-sans text-amber-800"> · no esperada</span>}
            {ver && dif != null && dif < 0 && <span className="font-sans font-semibold text-red-700"> · faltan {-dif}</span>}
            {!ciego && dif != null && dif > 0 && <span className="font-sans font-semibold text-amber-800"> · sobran {dif}</span>}
            {ver && dif === 0 && f.esperado > 0 && <span className="font-sans font-semibold text-green-700"> · completo</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {ver && f.esperado > 0 && n !== f.esperado && (
            <button type="button" onClick={() => corregir(f, f.esperado)} aria-label={`Llegaron las ${f.esperado} de ${nombre}`} title="Llegó todo" className={`${btn} rounded-md border border-gray-300 text-gray-700`}>✓</button>
          )}
          <button type="button" disabled={!n} onClick={() => corregir(f, (n ?? 0) - 1)} aria-label={`Una menos de ${nombre}`} className={`${btn} rounded-md border border-gray-300 text-gray-700 disabled:opacity-40`}>−</button>
          <input
            key={n ?? 'vacio'}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            defaultValue={n ?? ''}
            placeholder="—"
            onBlur={e => { if (e.target.value !== '') corregir(f, Number(e.target.value)) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            aria-label={`Cuántas llegaron de ${nombre}`}
            className={`${telefono ? 'min-h-11 w-16 text-base' : 'min-h-8 w-16 text-sm'} rounded-md border border-gray-300 px-2 text-right font-mono`}
          />
          <button type="button" onClick={() => corregir(f, (n ?? 0) + 1)} aria-label={`Una más de ${nombre}`} className={`${btn} rounded-md border border-gray-300 text-gray-700`}>+</button>
        </div>
      </div>
      {f.productId == null && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-red-700">{f.codigo == null ? 'Frena el cierre hasta asignarla o descartarla.' : 'No está en el catálogo: frena el cierre.'}</span>
          {f.codigo != null && <Link href={crearHref(f.codigo)} className="font-semibold text-blue-700 underline">Crear pieza</Link>}
          {asignando ? (
            <form onSubmit={e => { e.preventDefault(); identificar(String(new FormData(e.currentTarget).get('codigo'))); setAsignando(false) }} className="flex items-center gap-1">
              <input name="codigo" required autoFocus placeholder="Código de la pieza" aria-label="Código de la pieza a la que corresponde" className="min-h-9 w-36 rounded-md border border-gray-300 px-2 font-mono" />
              <button className="min-h-9 rounded-md bg-gray-900 px-3 font-semibold text-white">Asignar</button>
            </form>
          ) : (
            <button type="button" onClick={() => setAsignando(true)} className="font-semibold text-blue-700 underline">Es otra pieza…</button>
          )}
          {n !== 0 && <button type="button" onClick={() => corregir(f, 0)} className="text-gray-700 underline">Descartar</button>}
        </div>
      )}
    </li>
  )
}
