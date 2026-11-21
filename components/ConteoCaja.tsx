'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { limpiarNombre } from '@/lib/utils'
import { coincideParcial } from '@/lib/conteo'
import {
  DECISION_LABEL, estadoFila, progresoRecepcion, puedeCerrar,
  type Decision, type EstadoFila,
} from '@/lib/recepcion'
import type { OrigenLectura } from '@/lib/qr-bajaj'
import type { Estimada, ResultadoLectura, VistaRecepcion, FilaVista } from '@/lib/recepcion-db'
import {
  anotarEnRecepcion, cerrarEnRecepcion, ciegoEnRecepcion, corregirFila, deshacerEnRecepcion, identificarFila,
  leerEnRecepcion, sinIdentificarEnRecepcion,
} from '@/app/(pages)/envios/recepcion-actions'
import FormMedir from './FormMedir'
import { senal, type Senal } from './senal'

// Su portal necesita `document`: no se renderiza en el servidor.
const LectorCamara = dynamic(() => import('./LectorCamara'), { ssr: false })

type Para = NonNullable<Extract<ResultadoLectura, { tipo: 'sumo' }>['para']>

type Aviso =
  | {
      tipo: 'lectura'
      tono: Senal
      estado: EstadoFila
      contado: number
      esperado: number
      codigo: string | null
      nombre: string
      cantidad: number
      leidoComo: string | null
      para: Para
      ubicacion: string | null
      enCatalogo: boolean
      lecturaId?: number
    }
  | { tipo: 'texto'; tono: Senal; texto: string; ofrecer?: { raw: string; origen: OrigenLectura; crear: string | null } }
  | { tipo: 'varias'; filas: { lineaId: number; codigo: string | null; nombre: string }[] }

function senalDeEstado(estado: EstadoFila, ciego: boolean): Senal {
  if (estado === 'no_esperada') return 'sobra'
  if (ciego) return 'ok'
  if (estado === 'completa') return 'completa'
  if (estado === 'sobra') return 'sobra'
  return 'ok'
}

// Franja "Apartar para Abraham · #45" cuando alguna unidad es de cliente; si ninguna es de cliente,
// dice explícitamente que va al stock (o al stock como sobrante).
function destinoDeAviso(para: Para, estado: EstadoFila): { tipo: 'cliente' | 'sobrante' | 'stock'; texto: string } | null {
  if (para.some(d => d.cliente != null)) {
    if (para.length === 1 && para[0].unidades === 1) {
      return { tipo: 'cliente', texto: `Apartar para ${para[0].cliente}${para[0].pedidoId != null ? ` · #${para[0].pedidoId}` : ''}` }
    }
    const partes = para.map(d => `${d.cliente ?? 'stock'}${d.pedidoId != null ? ` (#${d.pedidoId})` : ''}${para.length > 1 || d.unidades > 1 ? ` ×${d.unidades}` : ''}`)
    return { tipo: 'cliente', texto: `Apartar para ${partes.join(' · ')}` }
  }
  if (estado === 'sobra' || estado === 'no_esperada') {
    return { tipo: 'sobrante', texto: '→ va al stock (sobrante)' }
  }
  if (para.length > 0) {
    return { tipo: 'stock', texto: '→ va al stock' }
  }
  return null
}

// El conteo de una recepción abierta (docs/plan-inventario/03-recepcion.md y 07-casos-telefono.md).
// El mismo en la laptop (pestaña Llegada de la caja) y en el teléfono (/escanear/recepcion/[id]):
// cada lectura va al servidor (lib/recepcion-db) y la pantalla pinta lo que contestó, así nunca
// muestra un número que la base no tiene. Cada lectura suma lo que trae la etiqueta (-2 suma 2).
export default function ConteoCaja({ vista, volver, volverLista, telefono = false, estimadas, refrescar = false }: {
  vista: VistaRecepcion
  /** A dónde vuelve "Crear pieza" después de guardarla. */
  volver: string
  /** Enlace de vuelta a la lista de cajas (solo en teléfono). */
  volverLista?: string
  telefono?: boolean
  /** Piezas con peso y medidas estimados (o medidas sin base), por código, para ofrecer medirlas. */
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
  const [sinId, setSinId] = useState<{ nota: string; cantidad: string } | null>(null)
  const [decisiones, setDecisiones] = useState<Record<number, Decision>>({})
  const [error, setError] = useState<string | null>(null)
  const [cerrando, setCerrando] = useState(false)
  const [mostrarCompletas, setMostrarCompletas] = useState(false)
  // La pregunta de medir: la primera lectura de un código estimado. "Ahora no" o medirla la apaga
  // para ese código durante la recepción. Guardar la medida no toca el conteo.
  const [aMedir, setAMedir] = useState<{ codigo: string; cantidad: number; midiendo: boolean } | null>(null)
  const [noMedir, setNoMedir] = useState<Set<string>>(new Set())
  const apagarMedir = (codigo: string) => { setNoMedir(s => new Set(s).add(codigo)); setAMedir(null) }
  const enVuelo = useRef(0)
  const cierreRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!refrescar) return
    const t = setInterval(() => { if (document.visibilityState === 'visible' && enVuelo.current === 0) router.refresh() }, 3000)
    return () => clearInterval(t)
  }, [refrescar, router])

  const ciego = r.ciego
  const fijar = (lineaId: number, contado: number | null) => setContados(c => ({ ...c, [lineaId]: contado }))

  function errorDe(res: { error: string; codigo?: string }): Senal {
    setAviso({ tipo: 'texto', tono: 'error', texto: res.error })
    if (res.codigo === 'cerrada') router.refresh()
    return 'error'
  }

  function pintar(res: ResultadoLectura, raw: string, origen: OrigenLectura): Senal {
    if (res.tipo === 'varias') { setAviso({ tipo: 'varias', filas: res.filas }); return 'error' }
    if (res.tipo === 'no_esperada') {
      setAviso({ tipo: 'texto', tono: 'error', texto: `${res.codigo} · ${limpiarNombre(res.nombre)} no viene en esta caja`, ofrecer: { raw, origen, crear: null } })
      return 'error'
    }
    if (res.tipo === 'fuera_catalogo') {
      setAviso({ tipo: 'texto', tono: 'error', texto: `${res.codigo} no está en el catálogo`, ofrecer: { raw, origen, crear: res.codigo } })
      return 'error'
    }
    // Etiqueta de estante: no suma; ubica la última pieza leída si no tenía lugar.
    if (res.tipo === 'estante') {
      if (res.asignada) { setAviso({ tipo: 'texto', tono: 'ok', texto: `${res.codigo ?? limpiarNombre(res.nombre ?? '')} → ${res.ubicacion}` }); return 'ok' }
      const pieza = res.codigo ?? limpiarNombre(res.nombre ?? '')
      setAviso({
        tipo: 'texto',
        tono: 'error',
        texto: res.codigo == null && res.nombre == null ? `Estante ${res.ubicacion}: escaneá primero una pieza.`
          : res.tenia ? `${pieza} ya está en ${res.tenia}: no se movió.`
            : `${pieza} no está en el catálogo: no se puede ubicar.`,
      })
      return 'error'
    }
    fijar(res.lineaId, res.contado)
    const tono = senalDeEstado(res.estado, ciego)
    setAviso({
      tipo: 'lectura',
      tono,
      estado: res.estado,
      contado: res.contado,
      esperado: res.esperado,
      codigo: res.codigo,
      nombre: res.nombre,
      cantidad: res.cantidad,
      leidoComo: res.leidoComo,
      para: res.para ?? [],
      ubicacion: res.ubicacion,
      enCatalogo: res.enCatalogo,
      lecturaId: res.lecturaId,
    })
    ofrecerMedir(res.codigo, res.cantidad)
    return tono
  }

  // La pregunta de medir, al escanear o al sumar con +. Una pregunta abierta con el formulario a
  // medio llenar no la pisa la lectura siguiente.
  function ofrecerMedir(codigo: string | null, cantidad: number) {
    const preguntar = codigo != null && estimadas?.[codigo] != null && !noMedir.has(codigo)
    setAMedir(a => (a?.midiendo ? a : preguntar ? { codigo, cantidad, midiendo: false } : null))
  }

  // Cada acción espera al servidor: la pantalla solo suma lo que quedó guardado.
  async function correr(pedir: () => Promise<{ ok: true; r: ResultadoLectura } | { ok: false; error: string; codigo?: string }>, raw: string, origen: OrigenLectura, estructural = false): Promise<Senal> {
    enVuelo.current++
    let tono: Senal = 'error'
    try {
      const res = await pedir()
      tono = res.ok ? pintar(res.r, raw, origen) : errorDe(res)
      if (res.ok && res.r.tipo === 'sumo') setTexto('')
      if (res.ok && estructural) router.refresh()
    } catch {
      setAviso({ tipo: 'texto', tono: 'error', texto: 'No se guardó: revisá la señal y reintentá.' })
    }
    enVuelo.current--
    senal(tono)
    return tono
  }

  const leer = (raw: string, origen: OrigenLectura) => {
    if (!raw.trim()) { senal('error'); setAviso({ tipo: 'texto', tono: 'error', texto: 'No se leyó ninguna etiqueta.' }); return 'error' as Senal }
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
      setAviso({ tipo: 'texto', tono: 'error', texto: 'No se guardó: revisá la señal y reintentá.' })
    }
    enVuelo.current--
  }

  const corregir = (f: FilaVista, total: number) => {
    if (!Number.isInteger(total) || total < 0 || total === f.contado) return
    void simple(() => corregirFila(f.id, total), res => {
      fijar(f.id, res.contado)
      const tono = senalDeEstado(res.estado, ciego)
      setAviso({
        tipo: 'lectura',
        tono,
        estado: res.estado,
        contado: res.contado,
        esperado: f.esperado,
        codigo: f.codigo,
        nombre: f.nombre,
        cantidad: Math.abs(res.contado - (f.contado ?? 0)),
        leidoComo: null,
        para: res.para,
        ubicacion: null,
        enCatalogo: false,
      })
      if (res.contado > (f.contado ?? 0)) ofrecerMedir(f.codigo, res.contado - (f.contado ?? 0))
    })
  }

  const buscando = texto.trim().length > 0
  const visibles = buscando ? filas.filter(f => coincideParcial({ clave: String(f.id), nombre: f.nombre, codigo: f.codigo, alternos: f.alternos }, texto)) : filas
  const contadas = filas.filter(f => f.contado != null).length
  const prog = progresoRecepcion(filas)
  const conDecision = filas.map(f => ({ ...f, decision: f.contado != null && f.contado < f.esperado ? decisiones[f.id] ?? f.decision : null }))
  const motivo = puedeCerrar(conDecision)
  const diferencias = conDecision.filter(f => f.contado != null && f.contado !== f.esperado)
  const crearHref = (codigo: string) => `/products/new?sku=${encodeURIComponent(codigo)}&volver=${encodeURIComponent(volver)}`
  const medible = aMedir && estimadas?.[aMedir.codigo] ? { ...aMedir, ...estimadas[aMedir.codigo] } : null
  const boton = telefono ? 'min-h-11 px-4 text-base' : 'min-h-9 px-3 text-sm'
  const tituloCaja = `${r.envio.nombre ?? `Caja #${r.envio.id}`} · ${r.envio.supplier?.name ?? '99rpm'}`
  const pct = ciego
    ? (filas.length > 0 ? Math.round((contadas / filas.length) * 100) : 0)
    : (prog.esperadas > 0 ? Math.min(100, Math.round((prog.contadas / prog.esperadas) * 100)) : 0)

  // Encabezado siempre visible (también encima de la cámara) con barra de progreso.
  const encabezado = (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {volverLista && (
            <Link href={volverLista} className="flex min-h-9 shrink-0 items-center pr-1 text-sm font-semibold text-blue-700">
              ← Recibir
            </Link>
          )}
          <span className="truncate text-sm font-bold text-gray-900">{tituloCaja}</span>
        </div>
        <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-gray-700">
          {ciego ? `${contadas} / ${filas.length} cód.` : `${prog.contadas} de ${prog.esperadas} piezas`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all duration-200 ${!ciego && prog.sobran > 0 ? 'bg-amber-500' : 'bg-emerald-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )

  // Barra fija abajo: resume lo que falta/sobra y salta directo al cierre.
  const partesPie: string[] = []
  if (ciego) {
    partesPie.push(`${contadas} de ${filas.length} códigos`)
  } else {
    if (prog.faltan > 0) partesPie.push(prog.faltan === 1 ? 'falta 1' : `faltan ${prog.faltan}`)
    if (prog.sobran > 0) partesPie.push(prog.sobran === 1 ? 'sobra 1' : `sobran ${prog.sobran}`)
    if (prog.faltan === 0 && prog.sobran === 0 && prog.esperadas > 0) partesPie.push('todo completo')
  }
  const listoParaCerrar = motivo == null && prog.faltan === 0 && prog.sobran === 0
  const pieBarra = (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => cierreRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-4 text-sm font-semibold text-white ${listoParaCerrar ? 'bg-emerald-700' : 'bg-gray-900'}`}
      >
        <span>Revisar y cerrar</span>
        {partesPie.length > 0 && <span className="font-mono text-xs font-medium tabular-nums text-white/90">{partesPie.join(' · ')}</span>}
      </button>
    </div>
  )

  const avisoVista = aviso && (
    <div role="status" aria-live="polite">
      {aviso.tipo === 'varias' ? (
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
      ) : aviso.tipo === 'texto' ? (
        <div className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${aviso.tono === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-green-200 bg-green-50 text-green-900'}`}>
          <p className={`flex-1 font-semibold ${telefono ? 'text-base' : 'text-sm'}`}>{aviso.texto}</p>
          {aviso.ofrecer && (
            <>
              <button type="button" onClick={() => void correr(() => anotarEnRecepcion(r.id, aviso.ofrecer!.raw, aviso.ofrecer!.origen), aviso.ofrecer!.raw, aviso.ofrecer!.origen, true)} className={`${boton} rounded-lg border border-red-300 bg-white font-semibold text-red-900`}>
                {aviso.ofrecer.crear ? 'Anotar' : 'Anotar como no esperada'}
              </button>
              {aviso.ofrecer.crear && <Link href={crearHref(aviso.ofrecer.crear)} className={`${boton} inline-flex items-center rounded-lg border border-red-300 bg-white font-semibold text-red-900`}>Crear pieza</Link>}
              <button type="button" onClick={() => setAviso(null)} className={`${boton} rounded-lg underline`}>Ignorar</button>
            </>
          )}
        </div>
      ) : (() => {
        const esSobra = aviso.tono === 'sobra'
        const esCompleta = aviso.tono === 'completa'
        const sobran = aviso.esperado > 0 ? aviso.contado - aviso.esperado : 0
        const faltan = aviso.esperado > 0 ? aviso.esperado - aviso.contado : 0
        const destino = destinoDeAviso(aviso.para, aviso.estado)
        const deCliente = aviso.para.some(d => d.cliente != null)
        const aStock = !deCliente || aviso.para.some(d => d.cliente == null)
        const cajaCls = esSobra
          ? 'border-amber-300 bg-amber-50 text-amber-950'
          : esCompleta
            ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
            : 'border-green-200 bg-green-50 text-green-950'
        return (
          <div className={`space-y-1.5 rounded-xl border px-3 py-2.5 ${cajaCls}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={`font-mono font-bold tabular-nums leading-none ${telefono ? 'text-2xl' : 'text-lg'}`}>
                  {!ciego && aviso.esperado > 0 ? `${aviso.contado} / ${aviso.esperado}` : aviso.contado}
                </span>
                {!ciego && aviso.estado === 'falta' && (
                  <span className="text-sm font-semibold text-green-800">
                    · {faltan === 1 ? 'falta 1' : `faltan ${faltan}`}
                  </span>
                )}
                {!ciego && aviso.estado === 'completa' && (
                  <span className="text-sm font-bold text-emerald-800">✓ completa</span>
                )}
                {!ciego && aviso.estado === 'sobra' && (
                  <span className="text-sm font-bold text-amber-900">
                    · Te pasaste: {sobran === 1 ? 'sobra 1' : `sobran ${sobran}`}
                  </span>
                )}
                {aviso.estado === 'no_esperada' && (
                  <span className="text-sm font-bold text-amber-900">· No esperada</span>
                )}
              </div>
              {aviso.lecturaId != null && (
                <button
                  type="button"
                  onClick={() => {
                    const id = aviso.lecturaId!
                    void simple(() => deshacerEnRecepcion(id), res => {
                      fijar(res.lineaId, res.contado)
                      setAviso({ tipo: 'texto', tono: 'ok', texto: 'Lectura deshecha.' })
                    })
                  }}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold ${esSobra ? 'border border-amber-400 bg-white text-amber-950' : 'underline'}`}
                >
                  Deshacer
                </button>
              )}
            </div>
            <p className="text-sm text-gray-900">
              {aviso.codigo && <span className="font-mono font-semibold">{aviso.codigo}</span>}
              {aviso.codigo && ' · '}
              <span>{limpiarNombre(aviso.nombre)}</span>
              {aviso.cantidad > 1 && <span className="text-gray-600"> (bolsa de {aviso.cantidad})</span>}
              {aviso.leidoComo && <span className="text-gray-600"> · leído como <span className="font-mono">{aviso.leidoComo}</span></span>}
            </p>
            {destino && (
              <p className={
                destino.tipo === 'cliente'
                  ? `rounded-lg bg-slate-900 px-3 py-1.5 font-bold text-white ${telefono ? 'text-base' : 'text-sm'}`
                  : destino.tipo === 'sobrante'
                    ? 'rounded-lg bg-amber-100/90 px-2.5 py-1 text-sm font-semibold text-amber-950'
                    : 'rounded-lg bg-white/80 px-2.5 py-1 text-sm font-medium text-gray-800'
              }>
                {destino.texto}
              </p>
            )}
            {aviso.enCatalogo && aStock && (
              <p className="text-xs text-gray-700">
                {aviso.ubicacion
                  ? <>Estante: <span className="font-mono font-semibold text-gray-900">{aviso.ubicacion}</span></>
                  : 'Sin ubicación · escaneá el estante'}
              </p>
            )}
          </div>
        )
      })()}
      {medible && (
        medible.midiendo ? (
          <div key={medible.codigo} className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <FormMedir pieza={medible} unidades={medible.cantidad} telefono={telefono}
              alGuardar={() => { apagarMedir(medible.codigo); setAviso({ tipo: 'texto', tono: 'ok', texto: `Medida guardada: ${medible.codigo}` }); router.refresh() }}
              alCancelar={() => apagarMedir(medible.codigo)} />
          </div>
        ) : medible.sinBase ? (
          /* Las medidas sin base van en una sola línea discreta: ya hay un número medido. */
          <div key={medible.codigo} className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600">
            <span className="truncate">Medida sin base (<span className="font-mono font-medium text-gray-800">{medible.codigo}</span>)</span>
            <div className="flex shrink-0 items-center gap-2.5">
              <button type="button" onClick={() => setAMedir({ ...medible, midiendo: true })} className="font-semibold text-gray-900 underline">Re-medir</button>
              <button type="button" onClick={() => apagarMedir(medible.codigo)} aria-label="Ocultar aviso de medida" className="text-gray-500">×</button>
            </div>
          </div>
        ) : (
          <div key={medible.codigo} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <span className="flex-1 text-sm text-amber-900">
              <span className="font-mono font-semibold">{medible.codigo}</span>: medidas estimadas. ¿La medís ahora?
            </span>
            <button type="button" onClick={() => setAMedir({ ...medible, midiendo: true })} className={`${boton} rounded-lg bg-amber-600 font-semibold text-white`}>
              Medir
            </button>
            <button type="button" onClick={() => apagarMedir(medible.codigo)} className={`${boton} rounded-lg text-gray-700 underline`}>Ahora no</button>
          </div>
        )
      )}
    </div>
  )

  // Agrupación por estado cuando no es ciego: lo que hay que resolver queda arriba sin buscarlo.
  const faltanFilas = visibles.filter(f => estadoFila(f.contado, f.esperado) === 'falta')
  const sobranFilas = visibles.filter(f => estadoFila(f.contado, f.esperado) === 'sobra')
  const noEsperadasFilas = visibles.filter(f => estadoFila(f.contado, f.esperado) === 'no_esperada')
  const sinContarFilas = visibles.filter(f => estadoFila(f.contado, f.esperado) === 'sin_contar')
  const completasFilas = visibles.filter(f => estadoFila(f.contado, f.esperado) === 'completa')
  const verCompletas = mostrarCompletas || buscando

  const renderFila = (f: FilaVista) => (
    <FilaConteo key={f.id} f={f} ciego={ciego} telefono={telefono} corregir={corregir} crearHref={crearHref}
      identificar={(raw) => void simple(() => identificarFila(f.id, raw), undefined, true)} />
  )

  const grupo = (titulo: string, lista: FilaVista[], colorTitulo: string) => lista.length > 0 && (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <h4 className={`text-xs font-semibold uppercase tracking-wide ${colorTitulo}`}>{titulo}</h4>
        <span className="font-mono text-xs tabular-nums text-gray-500">{lista.length}</span>
      </div>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {lista.map(renderFila)}
      </ul>
    </div>
  )

  const panel = (
    <div className="space-y-3">
      {avisoVista}
      <form role="search" className="flex gap-2" onSubmit={e => e.preventDefault()}>
        <input
          type="search"
          value={texto}
          onChange={e => setTexto(e.target.value)}
          autoFocus={!telefono}
          enterKeyHint="search"
          autoComplete="off"
          aria-label="Buscar por código o nombre"
          placeholder="Buscar por código o nombre"
          className={`min-w-0 flex-1 rounded-lg border border-gray-300 px-3 font-mono ${telefono ? 'min-h-11 text-base' : 'min-h-9 text-sm'}`}
        />
        {/* Solo busca: se suma escaneando con la cámara o con + en la fila. */}
        {!camara && <button type="button" onClick={() => setCamara(true)} className={`${boton} shrink-0 rounded-lg bg-gray-900 font-semibold text-white`}>Cámara</button>}
      </form>

      {visibles.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-3 py-4 text-sm text-gray-600">Ninguna fila coincide con «{texto}».</p>
      ) : ciego ? (
        <div className="space-y-1">
          <p className="text-xs text-gray-600">
            {contadas} de {filas.length} {filas.length === 1 ? 'código contado' : 'códigos contados'} · conteo ciego
          </p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {visibles.map(renderFila)}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          {grupo('Faltan', faltanFilas, 'text-red-700')}
          {grupo('Sobran', sobranFilas, 'text-amber-800')}
          {grupo('No esperadas / sin identificar', noEsperadasFilas, 'text-amber-800')}
          {grupo('Sin contar', sinContarFilas, 'text-gray-600')}
          {completasFilas.length > 0 && (
            <div className="space-y-1">
              <button
                type="button"
                aria-expanded={verCompletas}
                onClick={() => setMostrarCompletas(m => !m)}
                className="flex min-h-9 w-full items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-left"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Completas ({completasFilas.length})
                </span>
                <span className="text-xs font-medium text-gray-600">{verCompletas ? 'Ocultar' : 'Ver'}</span>
              </button>
              {verCompletas && (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                  {completasFilas.map(renderFila)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Acción secundaria debajo de la lista: no le quita espacio al buscador. */}
      <div>
        {sinId ? (
          <form
            onSubmit={e => {
              e.preventDefault()
              void simple(() => sinIdentificarEnRecepcion(r.id, sinId.nota, Number(sinId.cantidad)), () => setSinId(null), true)
            }}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-sm"
          >
            <input value={sinId.nota} onChange={e => setSinId({ ...sinId, nota: e.target.value })} autoFocus required placeholder="Qué es: bolsa con 6 tornillos, sin etiqueta…" aria-label="Nota de la pieza sin identificar" className="min-h-9 min-w-48 flex-1 rounded-lg border border-gray-300 bg-white px-3" />
            <input value={sinId.cantidad} onChange={e => setSinId({ ...sinId, cantidad: e.target.value })} type="number" min={1} step={1} inputMode="numeric" required aria-label="Cuántas" className="min-h-9 w-16 rounded-lg border border-gray-300 bg-white px-2 text-right font-mono" />
            <button className={`${boton} rounded-lg bg-gray-900 font-semibold text-white`}>Anotar</button>
            <button type="button" onClick={() => setSinId(null)} className={`${boton} rounded-lg text-gray-700`}>Cancelar</button>
          </form>
        ) : (
          <button type="button" onClick={() => setSinId({ nota: '', cantidad: '1' })} className="min-h-9 text-sm font-medium text-gray-600 underline hover:text-gray-900">
            + Anotar pieza sin identificar
          </button>
        )}
      </div>

      {/* Cierre: lo que no coincide y, en cada faltante, qué se hace con el resto. */}
      <section ref={cierreRef} aria-labelledby={`cierre-${r.id}`} className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
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

  if (camara) {
    return (
      <LectorCamara
        onLectura={raw => leer(raw, 'camara')}
        onCerrar={() => setCamara(false)}
        encabezado={encabezado}
        pie={pieBarra}
      >
        {panel}
      </LectorCamara>
    )
  }

  if (telefono) {
    return (
      <div className="flex min-h-[100dvh] flex-col">
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-white">{encabezado}</div>
        <div className="flex-1 p-3">{panel}</div>
        <div className="sticky bottom-0 z-10 border-t border-gray-200 bg-white">{pieBarra}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-gray-50">{encabezado}</div>
      {panel}
    </div>
  )
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
  const fondo = !ver || dif == null || dif === 0 ? '' : dif < 0 ? 'bg-red-50/60' : 'bg-amber-50/70'
  return (
    <li className={`px-3 py-2 ${fondo}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-gray-900">{f.codigo == null ? <><span className="font-semibold">Sin identificar:</span> {f.nombre}</> : limpiarNombre(f.nombre)}</p>
          <p className="font-mono text-sm tabular-nums text-gray-600">
            {f.codigo ?? '—'}
            {ver && f.esperado > 0 && <span className="font-sans"> · esperado {f.esperado}</span>}
            {f.esperado === 0 && <span className="font-sans text-amber-800"> · no esperada</span>}
            {ver && dif != null && dif < 0 && <span className="font-sans font-semibold text-red-700"> · {dif === -1 ? 'falta 1' : `faltan ${-dif}`}</span>}
            {!ciego && dif != null && dif > 0 && <span className="font-sans font-semibold text-amber-800"> · {dif === 1 ? 'sobra 1' : `sobran ${dif}`}</span>}
            {ver && dif === 0 && f.esperado > 0 && <span className="font-sans font-semibold text-emerald-700"> · completa</span>}
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
            className={`${telefono ? 'min-h-11 w-16 text-base' : 'min-h-8 w-16 text-sm'} rounded-md border border-gray-300 px-2 text-right font-mono tabular-nums`}
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
