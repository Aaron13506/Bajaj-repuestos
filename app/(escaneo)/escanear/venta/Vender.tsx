'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRef, useState } from 'react'
import { senal, type Senal } from '@/components/senal'
import { cuantoSumar } from '@/lib/venta-stock'
import { leerParaVender, piezaParaVender, type LecturaVenta, type PiezaVendible } from './actions'

// Abre de entrada, y su portal necesita `document`: no se renderiza en el servidor.
const LectorCamara = dynamic(() => import('@/components/LectorCamara'), { ssr: false })

type Linea = { pieza: PiezaVendible; cantidad: number }
type Aviso =
  | { tono: Senal; texto: string; deshacer?: { id: number; sumado: number } }
  | { tono: 'varias'; piezas: PiezaVendible[]; hayMas: boolean }

const codigo = (p: PiezaVendible) => p.bajajCode ?? p.nameEs

// Modo Vender: cada lectura suma a la venta en armado lo que dice la etiqueta (`-2` suma 2), sin
// pasar del stock; la cantidad se corrige en la lista. Nada se guarda acá: "Ir a cobrar" abre
// /ventas/new con el carrito cargado, y esa pantalla vuelve a validar el stock al registrar.
export default function Vender() {
  const [camara, setCamara] = useState(true)
  const [texto, setTexto] = useState('')
  const [carrito, setCarrito] = useState<Linea[]>([])
  // Lecturas seguidas: la segunda tiene que ver lo que sumó la primera aunque no haya re-render.
  const carritoRef = useRef<Linea[]>([])
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [pendientes, setPendientes] = useState(0)

  function cambiar(next: Linea[]) {
    carritoRef.current = next
    setCarrito(next)
  }

  function agregar(r: Extract<LecturaVenta, { tipo: 'pieza' }>): Senal {
    const p = r.pieza
    const actual = carritoRef.current
    const ya = actual.find(l => l.pieza.id === p.id)?.cantidad ?? 0
    const sumado = cuantoSumar(r.cantidad, p.stock, ya)
    if (sumado === 0) {
      setAviso({ tono: 'error', texto: p.stock === 0 ? `${codigo(p)}: no hay en el depósito.` : `${codigo(p)}: ya llevás las ${p.stock} que hay.` })
      return 'error'
    }
    cambiar(ya > 0
      ? actual.map(l => (l.pieza.id === p.id ? { pieza: p, cantidad: ya + sumado } : l))
      : [...actual, { pieza: p, cantidad: sumado }])
    const tope = sumado < r.cantidad
    const tono: Senal = tope ? 'error' : 'ok'
    setAviso({
      tono,
      texto: `${codigo(p)} · ${p.nameEs}: ${ya + sumado}${r.cantidad > 1 ? ` (bolsa de ${sumado})` : ''}` +
        (tope ? ` · solo hay ${p.stock}` : '') + (r.leidoComo ? ` · leído como ${r.leidoComo}` : ''),
      deshacer: { id: p.id, sumado },
    })
    return tono
  }

  // Solo suma cuando el servidor contestó: la pantalla nunca muestra algo que no leyó.
  async function procesar(pedir: () => Promise<LecturaVenta>): Promise<Senal> {
    setPendientes(n => n + 1)
    let tono: Senal = 'error'
    try {
      const r = await pedir()
      if (r.tipo === 'pieza') {
        tono = agregar(r)
        setTexto('')
      } else if (r.tipo === 'varias') {
        setAviso({ tono: 'varias', piezas: r.piezas, hayMas: r.hayMas })
      } else {
        setAviso({ tono: 'error', texto: `${r.codigo} no está en el catálogo.` })
      }
    } catch {
      setAviso({ tono: 'error', texto: 'No se pudo leer. Revisá la señal y reintentá.' })
    }
    senal(tono)
    setPendientes(n => n - 1)
    return tono
  }

  function leer(raw: string): Senal | Promise<Senal> {
    if (!raw.trim()) { // modo gatillo sin etiqueta en cuadro
      senal('error')
      setAviso({ tono: 'error', texto: 'No se leyó ninguna etiqueta.' })
      return 'error'
    }
    return procesar(() => leerParaVender(raw, false))
  }

  function fijar(id: number, cantidad: number) {
    cambiar(carritoRef.current.map(l => (l.pieza.id === id ? { ...l, cantidad: Math.max(0, Math.min(cantidad, l.pieza.stock)) } : l)))
  }

  function deshacer(id: number, sumado: number) {
    const l = carritoRef.current.find(x => x.pieza.id === id)
    if (!l) return
    const queda = l.cantidad - sumado
    cambiar(queda > 0 ? carritoRef.current.map(x => (x.pieza.id === id ? { ...x, cantidad: queda } : x)) : carritoRef.current.filter(x => x.pieza.id !== id))
    setAviso(null)
  }

  const lineas = carrito.filter(l => l.cantidad > 0)
  const unidades = lineas.reduce((s, l) => s + l.cantidad, 0)
  const cobrar = `/ventas/new?piezas=${lineas.map(l => `${l.pieza.id}:${l.cantidad}`).join(',')}`

  const panel = (
    <div className="space-y-3">
      <div role="status" aria-live="polite">
        {aviso && <VistaAviso aviso={aviso} deshacer={deshacer} elegir={id => void procesar(() => piezaParaVender(id))} />}
        {pendientes > 0 && !aviso && <p className="text-sm text-gray-500">Leyendo…</p>}
      </div>
      <form
        role="search"
        className="flex gap-2"
        onSubmit={e => { e.preventDefault(); if (texto.trim()) void procesar(() => leerParaVender(texto, true)) }}
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
        <button type="submit" className="min-h-11 rounded-lg bg-blue-600 px-4 font-semibold text-white">Agregar</button>
      </form>
      {carrito.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {carrito.map(l => (
            <li key={l.pieza.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-gray-900">{l.pieza.nameEs}</p>
                <p className="font-mono text-sm text-gray-600">{l.pieza.bajajCode ?? 'sin código'} · hay {l.pieza.stock}</p>
              </div>
              <button type="button" onClick={() => fijar(l.pieza.id, l.cantidad - 1)} aria-label={`Una menos de ${l.pieza.nameEs}`}
                className="min-h-11 min-w-11 rounded-lg border border-gray-300 text-lg font-semibold text-gray-700">−</button>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={l.pieza.stock}
                value={l.cantidad}
                onChange={e => fijar(l.pieza.id, parseInt(e.target.value, 10) || 0)}
                aria-label={`Cantidad de ${l.pieza.nameEs}`}
                className="min-h-11 w-14 rounded-lg border border-gray-300 text-center text-base"
              />
              <button type="button" onClick={() => fijar(l.pieza.id, l.cantidad + 1)} aria-label={`Una más de ${l.pieza.nameEs}`}
                disabled={l.cantidad >= l.pieza.stock}
                className="min-h-11 min-w-11 rounded-lg border border-gray-300 text-lg font-semibold text-gray-700 disabled:opacity-40">+</button>
            </li>
          ))}
        </ul>
      )}
      {lineas.length > 0 ? (
        <Link href={cobrar} className="flex min-h-12 w-full items-center justify-center rounded-lg bg-green-600 px-4 text-lg font-semibold text-white">
          Ir a cobrar · {unidades} u.
        </Link>
      ) : (
        <p className="text-sm text-gray-500">Escaneá o escribí un código para agregarlo a la venta.</p>
      )}
    </div>
  )

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">
          ← Modos
        </Link>
        <h1 className="text-lg font-bold text-gray-900">Vender{lineas.length > 0 && ` · ${lineas.length} pieza${lineas.length === 1 ? '' : 's'}`}</h1>
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

const COLOR: Record<Senal, string> = {
  ok: 'bg-green-50 text-green-900',
  error: 'bg-red-50 text-red-800',
}

function VistaAviso({ aviso, deshacer, elegir }: {
  aviso: Aviso
  deshacer: (id: number, sumado: number) => void
  elegir: (id: number) => void
}) {
  if (aviso.tono === 'varias') {
    return (
      <div className="space-y-2">
        <p className="font-medium text-amber-800">
          {aviso.hayMas ? `Más de ${aviso.piezas.length}` : aviso.piezas.length} piezas coinciden: elegí una{aviso.hayMas && ' o escribí más'}.
        </p>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {aviso.piezas.map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => elegir(p.id)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
                <span className="font-mono text-sm text-gray-600">{p.bajajCode ?? '—'}</span>
                <span className="flex-1 text-gray-900">{p.nameEs}</span>
                <span className="text-sm text-gray-600">hay {p.stock}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const d = aviso.deshacer
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${COLOR[aviso.tono]}`}>
      <p className="flex-1 text-lg font-semibold">{aviso.texto}</p>
      {d && (
        <button type="button" onClick={() => deshacer(d.id, d.sumado)} className="min-h-11 shrink-0 rounded-lg px-3 font-semibold underline">
          Deshacer
        </button>
      )}
    </div>
  )
}
