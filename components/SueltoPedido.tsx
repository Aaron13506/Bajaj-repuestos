'use client'

import { useState } from 'react'
import Link from 'next/link'
import PendingButton from './PendingButton'

// Una línea del presupuesto que todavía no viaja en ninguna caja.
export interface LineaSuelta {
  id: number
  nameEs: string
  bajajCode: string | null
  quantity: number
  salePrice: number
  descontinuada: boolean
}

// Dónde está el resto del presupuesto. Sin esto el desglose miente por omisión: muestra
// 3 líneas sueltas sin decir que las otras 7 ya viajan, y parece un presupuesto chico en
// vez de uno repartido.
export interface EnOtraCaja {
  envioId: number
  nombre: string
  lineas: number
}

interface Props {
  envioId: number
  pedidoId: number
  clientName: string
  tipo: string
  lineas: LineaSuelta[]
  otrasCajas: EnOtraCaja[]
  sinAprobar?: boolean
  agregarTodo: (envioId: number, pedidoId: number) => Promise<void>
  agregarElegidas: (envioId: number, itemIds: number[]) => Promise<void>
}

const usd = (n: number) => `$${n.toFixed(2)}`

export default function SueltoPedido({
  envioId,
  pedidoId,
  clientName,
  tipo,
  lineas,
  otrasCajas,
  sinAprobar,
  agregarTodo,
  agregarElegidas,
}: Props) {
  const [abierto, setAbierto] = useState(false)
  const [elegidas, setElegidas] = useState<Set<number>>(new Set())
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const alternar = (id: number) =>
    setElegidas(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const total = lineas.reduce((s, l) => s + l.salePrice * l.quantity, 0)
  const elegidasTotal = lineas
    .filter(l => elegidas.has(l.id))
    .reduce((s, l) => s + l.salePrice * l.quantity, 0)
  const todas = elegidas.size === lineas.length && lineas.length > 0

  async function mandarElegidas() {
    if (elegidas.size === 0) return
    setEnviando(true)
    setError(null)
    try {
      await agregarElegidas(envioId, Array.from(elegidas))
      setElegidas(new Set())
    } catch {
      setError('No se pudieron agregar las líneas.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="px-6 py-3 hover:bg-gray-50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link href={`/presupuestos/${pedidoId}`} className="text-sm font-medium text-gray-900 hover:text-blue-700">
            {clientName}
          </Link>
          <span className="ml-2 text-xs text-gray-400">
            #{pedidoId} · {lineas.length} {lineas.length === 1 ? 'ítem suelto' : 'ítems sueltos'} · {usd(total)}
          </span>
          {tipo === 'propio' && (
            <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              Stock propio
            </span>
          )}
          {sinAprobar && (
            <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
              Sin aprobar
            </span>
          )}
          {otrasCajas.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-500">
              Repartido:{' '}
              {otrasCajas.map((c, i) => (
                <span key={c.envioId}>
                  {i > 0 && ', '}
                  <Link href={`/envios/${c.envioId}`} className="text-blue-600 hover:underline">
                    {c.lineas} {c.lineas === 1 ? 'línea' : 'líneas'} en {c.nombre}
                  </Link>
                </span>
              ))}
              . Acá solo aparece lo que falta por traer.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setAbierto(a => !a)}
            className="text-xs text-gray-500 hover:text-gray-800"
          >
            {abierto ? 'Ocultar' : 'Elegir líneas'}
          </button>
          <form action={agregarTodo.bind(null, envioId, pedidoId)}>
            <PendingButton pendingLabel="Agregando…" className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              + Agregar
            </PendingButton>
          </form>
        </div>
      </div>

      {abierto && (
        <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-3 py-1.5 bg-gray-50 flex items-center justify-between gap-3 text-xs">
            <button
              type="button"
              onClick={() => setElegidas(todas ? new Set() : new Set(lineas.map(l => l.id)))}
              className="text-blue-600 hover:underline"
            >
              {todas ? 'Ninguna' : 'Todas'}
            </button>
            <span className="font-mono text-gray-500">
              {elegidas.size} de {lineas.length}
              {elegidas.size > 0 && ` · ${usd(elegidasTotal)}`}
            </span>
          </div>

          <ul className="divide-y divide-gray-50">
            {lineas.map(l => (
              <li key={l.id}>
                <label className="px-3 py-1.5 flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={elegidas.has(l.id)}
                    onChange={() => alternar(l.id)}
                    className="rounded border-gray-300"
                  />
                  <span className="font-mono text-xs text-gray-700 w-8 text-right shrink-0">{l.quantity}×</span>
                  <span className="font-mono text-xs text-gray-500 w-28 shrink-0">{l.bajajCode ?? '—'}</span>
                  <span className="flex-1 text-gray-900 truncate" title={l.nameEs}>{l.nameEs}</span>
                  {l.descontinuada && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">
                      NLS
                    </span>
                  )}
                  <span className="font-mono text-xs text-gray-600 w-16 text-right shrink-0">
                    {usd(l.salePrice * l.quantity)}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="px-3 py-2 bg-gray-50 flex items-center justify-between gap-3">
            {error ? (
              <span className="text-xs text-red-600">{error}</span>
            ) : (
              <span className="text-xs text-gray-400">
                Lo que no elijas queda suelto y se puede meter en otra caja.
              </span>
            )}
            <button
              type="button"
              onClick={mandarElegidas}
              disabled={elegidas.size === 0 || enviando}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {enviando ? 'Agregando…' : `Agregar ${elegidas.size || ''} ${elegidas.size === 1 ? 'línea' : 'líneas'}`.trim()}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
