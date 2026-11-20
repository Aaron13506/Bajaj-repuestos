'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { limpiarNombre } from '@/lib/utils'
import { coincideParcial } from '@/lib/conteo'
import { difConteo, motivoNoCierraConteo, pideNota } from '@/lib/conteo-inventario'
import type { FilaConteoVista, ResultadoConteo, VistaConteo } from '@/lib/conteo-inventario-db'
import { senal, type Senal } from '@/components/senal'
import { cerrarInventario, corregirEnInventario, leerEnInventario, moverAlEstanteDelConteo } from '../actions'

const LectorCamara = dynamic(() => import('@/components/LectorCamara'), { ssr: false })

type Aviso =
  | { tono: Senal; texto: string; deshacer?: { lineaId: number; antes: number | null; despues: number }; mover?: { productId: number; desde: string }; crear?: string }
  | { tono: 'varias'; piezas: { productId: number; codigo: string | null; nombre: string }[] }

// Contar un estante (o una lista) desde el teléfono, ciego: cada lectura suma lo que trae la etiqueta
// en su fila, y lo que aparece en el estante sin estar en la lista se agrega. La pantalla pinta lo
// que contestó el servidor (nunca un número que la base no tiene) y refresca cada 5 s para ver lo
// que cuenta otra pantalla. Al cerrar, cada diferencia es un movimiento 'conteo' del kardex.
export default function ConteoInventario({ vista }: { vista: VistaConteo }) {
  const router = useRouter()
  const c = vista
  const [contados, setContados] = useState<Record<number, number | null>>({})
  const [base, setBase] = useState(c.lineas)
  if (base !== c.lineas) {
    setBase(c.lineas)
    setContados(x => Object.fromEntries(Object.entries(x).filter(([id, v]) => c.lineas.find(l => l.id === Number(id))?.contado !== v)))
  }
  const filas = c.lineas.map(l => (l.id in contados ? { ...l, contado: contados[l.id] } : l))
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [texto, setTexto] = useState('')
  const [camara, setCamara] = useState(true)
  const [notas, setNotas] = useState(c.notas ?? '')
  const [error, setError] = useState<string | null>(null)
  const [cerrando, setCerrando] = useState(false)
  // Ciego: lo que dice el sistema recién se ve al terminar de contar.
  const [revisar, setRevisar] = useState(false)
  const enVuelo = useRef(0)
  const fijar = (lineaId: number, contado: number | null) => setContados(x => ({ ...x, [lineaId]: contado }))

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && enVuelo.current === 0) router.refresh() }, 5000)
    return () => clearInterval(t)
  }, [router])

  async function pedir<T>(accion: () => Promise<{ ok: true; r: T } | { ok: false; error: string; codigo?: string }>): Promise<T | null> {
    enVuelo.current++
    try {
      const res = await accion()
      if (res.ok) return res.r
      setAviso({ tono: 'error', texto: res.error })
      if (res.codigo === 'cerrado') router.refresh()
    } catch {
      setAviso({ tono: 'error', texto: 'No se guardó: revisá la señal y reintentá.' })
    } finally {
      enVuelo.current--
    }
    return null
  }

  function pintar(r: ResultadoConteo): Senal {
    if (r.tipo === 'varias') { setAviso({ tono: 'varias', piezas: r.piezas }); return 'error' }
    if (r.tipo === 'fuera_catalogo') { setAviso({ tono: 'error', texto: `${r.codigo} no está en el catálogo`, crear: r.codigo }); return 'error' }
    if (r.tipo === 'estante') {
      if (r.mismo) { setAviso({ tono: 'ok', texto: `Estás contando ${r.ubicacion}.` }); return 'ok' }
      setAviso({ tono: 'error', texto: c.ubicacion ? `Este conteo es del estante ${c.ubicacion}, no de ${r.ubicacion}.` : `Este conteo es por lista, no de un estante.` })
      return 'error'
    }
    fijar(r.lineaId, r.contado)
    if (r.nueva) router.refresh()
    const bolsa = r.cantidad > 1
    setAviso({
      tono: 'ok',
      texto: `${r.codigo ?? ''} · ${limpiarNombre(r.nombre)}: ${r.contado}${bolsa ? ` (bolsa de ${r.cantidad})` : ''}${r.nueva ? ' (no estaba en la lista)' : ''}`,
      deshacer: { lineaId: r.lineaId, antes: r.antes, despues: r.contado },
      mover: r.estabaEn ? { productId: r.productId, desde: r.estabaEn } : undefined,
    })
    return 'ok'
  }

  async function leer(raw: string, manual: boolean, productId?: number): Promise<Senal> {
    if (!raw.trim() && productId == null) { senal('error'); setAviso({ tono: 'error', texto: 'No se leyó ninguna etiqueta.' }); return 'error' }
    const r = await pedir(() => leerEnInventario(c.id, raw, manual, productId))
    const tono = r ? pintar(r) : 'error'
    if (r?.tipo === 'sumo') setTexto('')
    senal(tono)
    return tono
  }

  async function corregir(f: FilaConteoVista, total: number | null) {
    if (total != null && (!Number.isInteger(total) || total < 0)) return
    if (total === f.contado) return
    const r = await pedir(() => corregirEnInventario(f.id, total))
    if (r) { fijar(f.id, r.contado); setAviso({ tono: 'ok', texto: `${f.codigo ?? limpiarNombre(f.nombre)} → ${r.contado ?? 'sin contar'}` }) }
  }

  const visibles = texto.trim() ? filas.filter(f => coincideParcial({ clave: String(f.id), nombre: f.nombre, codigo: f.codigo, alternos: f.alternos }, texto)) : filas
  const contadas = filas.filter(f => f.contado != null).length
  const motivo = motivoNoCierraConteo(filas, notas)
  const diferencias = filas.filter(f => (difConteo(f) ?? 0) !== 0)
  const movidas = filas.filter(f => f.contado != null && f.movidaDurante)
  const boton = 'min-h-11 px-4 text-base'

  const avisoVista = aviso && (
    <div role="status" aria-live="polite">
      {aviso.tono === 'varias' ? (
        <div className="space-y-2">
          <p className="font-medium text-amber-800">{aviso.piezas.length} piezas coinciden: elegí cuál sumar.</p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {aviso.piezas.map(p => (
              <li key={p.productId}>
                <button type="button" onClick={() => void leer('', true, p.productId)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
                  <span className="font-mono text-sm text-gray-600">{p.codigo ?? '—'}</span>
                  <span className="flex-1 text-gray-900">{limpiarNombre(p.nombre)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 ${aviso.tono === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-800'}`}>
          <p className="flex-1 text-lg font-semibold">{aviso.texto}</p>
          {aviso.crear && <Link target="_blank" href={`/products/new?sku=${encodeURIComponent(aviso.crear)}`} className={`${boton} inline-flex items-center rounded-lg border border-red-300 font-semibold`}>Crear pieza</Link>}
          {aviso.deshacer && (
            <button
              type="button"
              onClick={async () => {
                const d = aviso.deshacer!
                const r = await pedir(() => corregirEnInventario(d.lineaId, d.antes, d.despues))
                if (r) { fijar(d.lineaId, r.contado); setAviso({ tono: 'ok', texto: 'Deshecho.' }) }
              }}
              className={`${boton} rounded-lg font-semibold underline`}
            >
              Deshacer
            </button>
          )}
          {aviso.mover && (
            <div className="flex w-full flex-wrap items-center gap-2 border-t border-current/20 pt-2">
              <span className="flex-1 text-base">Estaba en {aviso.mover.desde}. ¿La muevo a {c.ubicacion}?</span>
              <button
                type="button"
                onClick={async () => {
                  const m = aviso.mover!
                  const r = await pedir(() => moverAlEstanteDelConteo(c.id, m.productId))
                  if (r) setAviso({ tono: 'ok', texto: `${r.codigo ?? limpiarNombre(r.nombre)}: de ${m.desde} a ${r.ubicacion}` })
                }}
                className={`${boton} rounded-lg bg-amber-600 font-semibold text-white`}
              >
                Moverla
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )

  const panel = (
    <div className="space-y-3">
      {avisoVista}
      <form role="search" className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (texto.trim()) void leer(texto, true) }}>
        <input
          type="search"
          value={texto}
          onChange={e => setTexto(e.target.value)}
          enterKeyHint="go"
          autoComplete="off"
          aria-label="Código, parte del código o nombre"
          placeholder="Código (o parte) o nombre + Enter"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 font-mono text-base"
        />
        <button type="submit" className={`${boton} rounded-lg bg-blue-600 font-semibold text-white`}>Sumar</button>
        {!camara && <button type="button" onClick={() => setCamara(true)} className={`${boton} rounded-lg bg-gray-900 font-semibold text-white`}>Cámara</button>}
      </form>
      <p className="text-sm text-gray-600">{contadas} de {filas.length} piezas contadas · conteo ciego: lo que dice el sistema aparece al cerrar</p>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {visibles.map(f => <Fila key={f.id} f={f} corregir={corregir} />)}
        {visibles.length === 0 && (
          <li className="px-3 py-4 text-sm text-gray-600">
            {filas.length === 0 ? 'El estante no tiene piezas asignadas: escaneá lo que hay y se agregan.' : `Ninguna fila coincide con «${texto}». Enter la busca en el catálogo.`}
          </li>
        )}
      </ul>

      <section aria-labelledby={`cierre-${c.id}`} className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
        <h3 id={`cierre-${c.id}`} className="font-semibold text-gray-900">Cerrar el conteo</h3>
        {!revisar ? (
          <button type="button" onClick={() => { setRevisar(true); router.refresh() }} className={`${boton} rounded-lg border border-gray-300 font-semibold text-gray-800`}>
            Terminé de contar: ver diferencias
          </button>
        ) : <>
        {diferencias.length === 0
          ? <p className="text-sm text-gray-600">{contadas > 0 ? 'Lo contado coincide con el stock.' : 'Las diferencias aparecen acá a medida que contás.'}</p>
          : (
            <ul className="space-y-1 text-sm">
              {diferencias.map(f => {
                const d = difConteo(f)!
                return (
                  <li key={f.id}>
                    <span className="font-mono">{f.codigo ?? '—'}</span> · {limpiarNombre(f.nombre)}: contaste {f.contado}, el sistema dice {f.stockAhora}{' '}
                    <span className={`font-semibold ${d < 0 ? 'text-red-700' : 'text-amber-800'}`}>({d > 0 ? `+${d}` : d}{pideNota(f) ? ', pide nota' : ''})</span>
                  </li>
                )
              })}
            </ul>
          )}
        {movidas.length > 0 && (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Se movieron mientras contabas: {movidas.map(f => f.codigo ?? limpiarNombre(f.nombre)).join(', ')}. El ajuste es contra el stock de ahora: si la contaste antes de esa venta o entrada, corregí el número.
          </p>
        )}
        <label className="block text-sm">
          <span className="text-gray-700">Nota (obligatoria con diferencias grandes)</span>
          <textarea value={notas} onChange={e => setNotas(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base" />
        </label>
        {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={motivo != null || cerrando}
            onClick={async () => {
              setCerrando(true)
              setError(null)
              try {
                const res = await cerrarInventario(c.id, notas)
                if (!res.ok) setError(res.error)
                router.refresh()
              } catch {
                setError('No se pudo cerrar: revisá la señal y reintentá.')
              }
              setCerrando(false)
            }}
            className={`${boton} rounded-lg bg-emerald-700 font-semibold text-white disabled:opacity-40`}
          >
            {cerrando ? 'Cerrando…' : 'Cerrar conteo'}
          </button>
          {motivo && <p className="text-sm text-gray-600">{motivo}</p>}
        </div>
        </>}
        <p className="text-xs text-gray-600">Al cerrar, cada diferencia queda como un movimiento «Conteo» en el kardex de la pieza. Lo que no contaste no se toca.</p>
      </section>
    </div>
  )

  return camara
    ? <LectorCamara onLectura={raw => leer(raw, false)} onCerrar={() => setCamara(false)}>{panel}</LectorCamara>
    : panel
}

// Una fila: − / cantidad / +. Ciega: sin lo que dice el sistema.
function Fila({ f, corregir }: { f: FilaConteoVista; corregir: (f: FilaConteoVista, total: number | null) => void }) {
  const n = f.contado
  const btn = 'min-h-11 min-w-11 text-lg rounded-md border border-gray-300 text-gray-700 disabled:opacity-40'
  const nombre = f.codigo ?? f.nombre
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-gray-900">{limpiarNombre(f.nombre)}</p>
        <p className="font-mono text-sm text-gray-600">{f.codigo ?? '—'}{n == null && <span className="font-sans"> · sin contar</span>}</p>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" disabled={!n} onClick={() => corregir(f, (n ?? 0) - 1)} aria-label={`Una menos de ${nombre}`} className={btn}>−</button>
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
          aria-label={`Cuántas hay de ${nombre}`}
          className="min-h-11 w-16 rounded-md border border-gray-300 px-2 text-right font-mono text-base"
        />
        <button type="button" onClick={() => corregir(f, (n ?? 0) + 1)} aria-label={`Una más de ${nombre}`} className={btn}>+</button>
      </div>
    </li>
  )
}
