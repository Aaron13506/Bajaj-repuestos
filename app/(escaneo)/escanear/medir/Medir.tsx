'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRef, useState } from 'react'
import IndicadorMedido from '@/components/IndicadorMedido'
import FormMedir from '@/components/FormMedir'
import { senal, type Senal } from '@/components/senal'
import { leerParaMedir, piezaParaMedir, type LecturaMedir } from './actions'

// Abre de entrada, y su portal necesita `document`: no se renderiza en el servidor.
const LectorCamara = dynamic(() => import('@/components/LectorCamara'), { ssr: false })

type Resultado = LecturaMedir | { tipo: 'error'; mensaje: string } | { tipo: 'guardado'; texto: string }

// Modo Medir (06-telefono.md): se escanea y abre el formulario de peso y medidas directo, sin
// contar. Caja o bolsa como en FormMedir; si la etiqueta era una bolsa de N, arranca en bolsa con N.
export default function Medir({ inicial }: { inicial: LecturaMedir | null }) {
  const [camara, setCamara] = useState(inicial == null)
  const [texto, setTexto] = useState('')
  const [res, setRes] = useState<Resultado | null>(inicial)
  const [cargando, setCargando] = useState(false)
  const ultima = useRef(0) // solo pinta la respuesta de la última lectura, aunque lleguen desordenadas

  async function leer(pedir: () => Promise<LecturaMedir>): Promise<Senal> {
    const n = ++ultima.current
    setCargando(true)
    let r: Resultado
    try { r = await pedir() } catch { r = { tipo: 'error', mensaje: 'No se pudo leer. Revisá la señal y reintentá.' } }
    const tono: Senal = r.tipo === 'pieza' ? 'ok' : 'error'
    senal(tono)
    if (n === ultima.current) { setRes(r); setCargando(false) }
    return tono
  }

  function lectura(raw: string): Senal | Promise<Senal> {
    if (!raw.trim()) {
      senal('error')
      setRes({ tipo: 'error', mensaje: 'No se leyó ninguna etiqueta.' })
      return 'error'
    }
    return leer(() => leerParaMedir(raw, false))
  }

  const panel = (
    <div className="space-y-3">
      <form role="search" className="flex gap-2" onSubmit={e => { e.preventDefault(); if (texto.trim()) void leer(() => leerParaMedir(texto, true)) }}>
        <input
          type="search"
          value={texto}
          onChange={e => setTexto(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
          aria-label="Código, parte del código o nombre"
          placeholder="Código, parte del código o nombre"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
        <button type="submit" className="min-h-11 rounded-lg bg-blue-600 px-4 font-semibold text-white">Buscar</button>
      </form>
      <div role="status" aria-live="polite">
        {cargando ? <p className="text-sm text-gray-500">Buscando…</p> : res && <Vista res={res} setRes={setRes} elegir={(id, cantidad) => void leer(() => piezaParaMedir(id, cantidad))} />}
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">← Modos</Link>
        <h1 className="text-lg font-bold text-gray-900">Medir</h1>
        <button type="button" onClick={() => setCamara(true)} className="min-h-11 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white">Cámara</button>
      </div>
      {camara ? <LectorCamara onLectura={lectura} onCerrar={() => setCamara(false)}>{panel}</LectorCamara> : panel}
    </div>
  )
}

function Vista({ res, setRes, elegir }: { res: Resultado; setRes: (r: Resultado | null) => void; elegir: (id: number, cantidad: number) => void }) {
  if (res.tipo === 'guardado') return <p className="rounded-lg bg-green-50 px-3 py-2 font-semibold text-green-900">{res.texto}</p>
  if (res.tipo === 'error') return <p className="rounded-lg bg-red-50 px-3 py-2 font-medium text-red-800">{res.mensaje}</p>
  if (res.tipo === 'ninguna') {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
        <p className="font-medium"><span className="font-mono">{res.codigo}</span> no está en el catálogo.</p>
        <Link target="_blank" href={`/products/new?sku=${encodeURIComponent(res.codigo)}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-blue-700 underline">Crear pieza</Link>
      </div>
    )
  }
  if (res.tipo === 'varias') {
    return (
      <div className="space-y-2">
        <p className="font-medium text-amber-800">{res.hayMas ? `Más de ${res.piezas.length}` : res.piezas.length} piezas coinciden: elegí una{res.hayMas && ' o escribí más'}.</p>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {res.piezas.map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => elegir(p.id, res.cantidad)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
                <span className="font-mono text-sm text-gray-600">{p.bajajCode ?? '—'}</span>
                <span className="text-gray-900">{p.nameEs}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const p = res.pieza
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
      <div>
        <p className="text-lg font-semibold text-gray-900">{p.nameEs}</p>
        <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-gray-600">
          {p.bajajCode ?? 'sin código'}
          {res.leidoComo && <span className="font-sans">(leído como {res.leidoComo})</span>}
          <IndicadorMedido medidoAt={p.medidoAt} base={p.medidaBase} />
        </p>
      </div>
      <FormMedir
        key={`${p.productId}-${res.cantidad}`}
        pieza={p}
        unidades={res.cantidad}
        telefono
        cancelar="Cancelar"
        alGuardar={() => { senal('ok'); setRes({ tipo: 'guardado', texto: `Guardada: ${p.bajajCode ?? p.nameEs}. Escaneá la siguiente.` }) }}
        alCancelar={() => setRes(null)}
      />
    </div>
  )
}
