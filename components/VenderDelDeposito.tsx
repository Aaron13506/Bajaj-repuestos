'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Miniatura from '@/components/Miniatura'
import { buscarEnStock, type PiezaEnStock } from '@/app/(pages)/ventas/actions'
import { shortModel } from '@/lib/modelo'

const usd = (n: number) => `$${n.toFixed(2)}`
// Las motos de una pieza en una línea: las dos primeras y cuántas más.
const motos = (ids: readonly string[]) =>
  ids.length === 0 ? null : ids.length <= 2 ? ids.map(shortModel).join(', ') : `${ids.slice(0, 2).map(shortModel).join(', ')} y ${ids.length - 2} más`

// El buscador del inicio: lo que te piden por nombre o código, con su precio y cuántas hay.
// «Vender» abre la venta con la pieza en el carrito; si no está en stock, se cotiza.
// La búsqueda es la misma de /ventas/new (buscarEnStock), con la misma espera de 250 ms.
export default function VenderDelDeposito({ piezas, unidades }: { piezas: number; unidades: number }) {
  const [q, setQ] = useState('')
  const termino = q.trim()
  const [hecha, setHecha] = useState<{ q: string; piezas: PiezaEnStock[]; error: boolean } | null>(null)

  useEffect(() => {
    if (termino.length < 2) return
    let cancelado = false
    const t = setTimeout(async () => {
      let res: PiezaEnStock[] = []
      let error = false
      try {
        res = await buscarEnStock(termino)
      } catch {
        error = true
      }
      if (!cancelado) setHecha({ q: termino, piezas: res, error })
    }, 250)
    return () => { cancelado = true; clearTimeout(t) }
  }, [termino])

  const corto = termino.length < 2
  const lista = !corto && hecha?.q === termino ? hecha : null
  const cotizar = <Link href="/presupuestos/new" className="text-blue-700 hover:underline">cotizalo como presupuesto</Link>

  return (
    <section aria-labelledby="vender-h" className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
        <h2 id="vender-h" className="text-base font-semibold text-gray-900">Vender del depósito</h2>
        <p className="text-xs text-gray-500 tabular-nums">
          {piezas} {piezas === 1 ? 'pieza' : 'piezas'} en stock · {unidades} {unidades === 1 ? 'unidad' : 'unidades'}
        </p>
      </div>
      <label htmlFor="vender-q" className="sr-only">Buscar una pieza en stock por nombre o código</label>
      <input
        id="vender-q"
        type="search"
        autoComplete="off"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Nombre o código de la pieza"
        className="h-11 w-full border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />

      {lista && lista.piezas.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100">
          {lista.piezas.map(p => {
            const m = motos(p.models)
            return (
              <li key={p.id} className="py-2.5 flex items-center gap-3">
                <Miniatura src={p.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 break-words">{p.nameEs}</p>
                  <p className="text-xs text-gray-500 break-words">
                    {p.bajajCode && <span className="tabular-nums">{p.bajajCode}</span>}
                    {p.bajajCode && m && ' · '}
                    {m}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-gray-900 tabular-nums">{usd(p.price)}</p>
                  <p className="text-xs text-gray-500 tabular-nums">{p.stock} en stock</p>
                </div>
                <Link
                  href={`/ventas/new?pieza=${p.id}`}
                  className="inline-flex items-center justify-center min-h-10 px-3 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50 shrink-0"
                >
                  Vender<span className="sr-only"> {p.nameEs}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {/* Siempre montado: el lector de pantalla anuncia cuántas encontró o que no hay. */}
      <p role="status" className="text-sm text-gray-500 mt-2 text-pretty empty:hidden">
        {corto ? (
          <>Escribí al menos dos letras. Lo que no tenés, {cotizar}.</>
        ) : !lista ? (
          'Buscando…'
        ) : lista.error ? (
          <span className="text-red-700">No se pudo buscar. Revisá la conexión y escribí de nuevo.</span>
        ) : lista.piezas.length === 0 ? (
          <>No hay «{termino}» en el depósito: {cotizar}.</>
        ) : lista.piezas.length === 12 ? (
          'Las primeras 12. Escribí más para afinar.'
        ) : (
          `${lista.piezas.length} ${lista.piezas.length === 1 ? 'pieza encontrada' : 'piezas encontradas'}.`
        )}
      </p>
    </section>
  )
}
