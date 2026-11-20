'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRef, useState } from 'react'
import IndicadorMedido from '@/components/IndicadorMedido'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { senal, type Senal } from '@/components/senal'
import { shippingStatusMeta } from '@/lib/shipping-status'
import { consultarCodigo, consultarPieza, type Consulta, type Ficha } from './actions'

// Abre de entrada, y su portal necesita `document`: no se renderiza en el servidor.
const LectorCamara = dynamic(() => import('@/components/LectorCamara'), { ssr: false })

type Resultado = Consulta | { tipo: 'error'; mensaje: string }

// Modo Consultar: la cámara abre sola; cada lectura (o lo tecleado) trae la ficha corta de la
// pieza. Pitido agudo = la encontró; grave = no está o hay varias (hay que mirar).
export default function Consultar() {
  const [camara, setCamara] = useState(true)
  const [texto, setTexto] = useState('')
  const [res, setRes] = useState<Resultado | null>(null)
  const [cargando, setCargando] = useState(false)
  const ultima = useRef(0) // solo pinta la respuesta de la última consulta, aunque lleguen desordenadas

  async function consultar(pedir: () => Promise<Consulta>): Promise<Senal> {
    const n = ++ultima.current
    setCargando(true)
    let r: Resultado
    try { r = await pedir() } catch { r = { tipo: 'error', mensaje: 'No se pudo consultar. Revisá la señal y reintentá.' } }
    const tono: Senal = r.tipo === 'ficha' ? 'ok' : 'error'
    senal(tono)
    if (n === ultima.current) { setRes(r); setCargando(false) }
    return tono
  }

  function leer(raw: string): Senal | Promise<Senal> {
    if (!raw.trim()) { // modo gatillo sin etiqueta en cuadro
      senal('error')
      setRes({ tipo: 'error', mensaje: 'No se leyó ninguna etiqueta.' })
      return 'error'
    }
    return consultar(() => consultarCodigo(raw, false))
  }

  const panel = (
    <div className="space-y-3">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={e => { e.preventDefault(); if (texto.trim()) void consultar(() => consultarCodigo(texto, true)) }}
      >
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
        {cargando ? <p className="text-sm text-gray-500">Buscando…</p> : res && <Vista res={res} elegir={id => void consultar(() => consultarPieza(id))} />}
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">
          ← Modos
        </Link>
        <h1 className="text-lg font-bold text-gray-900">Consultar</h1>
        <button type="button" onClick={() => setCamara(true)} className="min-h-11 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white">
          Cámara
        </button>
      </div>
      {camara ? (
        <LectorCamara onLectura={leer} onCerrar={() => setCamara(false)}>{panel}</LectorCamara>
      ) : panel}
    </div>
  )
}

function Vista({ res, elegir }: { res: Resultado; elegir: (id: number) => void }) {
  if (res.tipo === 'error') {
    return <p className="rounded-lg bg-red-50 px-3 py-2 font-medium text-red-800">{res.mensaje}</p>
  }
  if (res.tipo === 'ninguna') {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
        <p className="font-medium"><span className="font-mono">{res.codigo}</span> no está en el catálogo.</p>
        <Link href={`/products/new?sku=${encodeURIComponent(res.codigo)}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-blue-700 underline">
          Crear pieza
        </Link>
      </div>
    )
  }
  if (res.tipo === 'varias') {
    return (
      <div className="space-y-2">
        <p className="font-medium text-amber-800">
          {res.hayMas ? `Más de ${res.piezas.length}` : res.piezas.length} piezas coinciden: elegí una{res.hayMas && ' o escribí más'}.
        </p>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {res.piezas.map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => elegir(p.id)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
                <span className="font-mono text-sm text-gray-600">{p.bajajCode ?? '—'}</span>
                <span className="text-gray-900">{p.nameEs}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return <FichaCorta f={res.ficha} leidoComo={res.leidoComo} />
}

const cm = (n: number | null) => (n == null ? '—' : String(n))

function FichaCorta({ f, leidoComo }: { f: Ficha; leidoComo: string | null }) {
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
      <div>
        <p className={`text-lg font-semibold ${f.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}`}>{f.nameEs}</p>
        <p className="font-mono text-sm text-gray-600">
          {f.bajajCode ?? 'sin código'}{f.altSku && ` · ${f.altSku}`}
          {leidoComo && <span className="font-sans"> (leído como {leidoComo})</span>}
        </p>
        <ChipDescontinuada activo={f.descontinuada} />
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-gray-50 p-2">
          <dt className="text-gray-500">Stock</dt>
          <dd className="text-2xl font-bold text-gray-900">{f.stock}</dd>
        </div>
        <div className="rounded-lg bg-gray-50 p-2">
          <dt className="text-gray-500">Precio de venta</dt>
          <dd className="text-2xl font-bold text-gray-900">${f.precioUsd.toFixed(2)}</dd>
        </div>
        <div className="col-span-2 rounded-lg bg-gray-50 p-2">
          <dt className="flex items-center gap-2 text-gray-500">Peso y medidas <IndicadorMedido medidoAt={f.medidoAt} /></dt>
          <dd className="text-gray-900">
            {f.weightGrams == null ? '—' : `${f.weightGrams} g`} · {cm(f.dimL)} × {cm(f.dimA)} × {cm(f.dimH)} cm
          </dd>
        </div>
      </dl>
      {f.enCamino.length > 0 && (
        <div>
          <p className="text-sm font-medium text-gray-700">En camino (stock propio)</p>
          <ul className="text-sm">
            {f.enCamino.map(c => (
              <li key={c.envioId}>
                <Link href={`/envios/${c.envioId}`} className="inline-flex min-h-11 items-center text-blue-700 underline">
                  {c.nombre} · {c.unidades} u.
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {f.pedidos.length > 0 && (
        <div>
          <p className="text-sm font-medium text-gray-700">Pedidos de clientes</p>
          <ul className="text-sm">
            {f.pedidos.map(p => (
              <li key={p.pedidoId}>
                <Link href={`/presupuestos/${p.pedidoId}`} className="inline-flex min-h-11 items-center text-blue-700 underline">
                  #{p.pedidoId} {p.cliente} · {p.cantidad} u. · {shippingStatusMeta(p.etapa).short}
                  {p.envioId != null && ` · caja #${p.envioId}`}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Link href={`/products/${f.id}`} className="inline-flex min-h-11 items-center font-semibold text-blue-700 underline">
        Ficha completa
      </Link>
    </div>
  )
}
