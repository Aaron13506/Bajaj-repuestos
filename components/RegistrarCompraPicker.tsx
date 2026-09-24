'use client'

import { useMemo, useState, useTransition } from 'react'
import type { ItemPendienteCosto } from '@/lib/movimientos'

interface Props {
  items: ItemPendienteCosto[]
  action: (formData: FormData) => Promise<void>
  methods: readonly string[]
  // Modo embebido (ej. en /envios/[id]): arranca cerrado detrás de un botón, porque la
  // ficha del envío ya tiene bastante contenido abierto. En /contabilidad/comprar, donde
  // el picker ES la página, no aplica — arranca abierto y sin botón.
  collapsible?: boolean
}

const usd = (n: number) => `$${n.toFixed(2)}`

export default function RegistrarCompraPicker({ items, action, methods, collapsible = false }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [abierto, setAbierto] = useState(!collapsible)
  const [isPending, startTransition] = useTransition()
  const today = new Date().toISOString().slice(0, 10)

  const grupos = useMemo(() => {
    const porPedido = new Map<number, { pedidoId: number; clientName: string; items: ItemPendienteCosto[] }>()
    for (const i of items) {
      let g = porPedido.get(i.pedidoId)
      if (!g) {
        g = { pedidoId: i.pedidoId, clientName: i.clientName, items: [] }
        porPedido.set(i.pedidoId, g)
      }
      g.items.push(i)
    }
    return [...porPedido.values()]
  }, [items])

  function toggleItem(id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGrupo(ids: number[], marcar: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) {
        if (marcar) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const seleccionados = items.filter(i => selected.has(i.id))
  const estimadoTotal = seleccionados.reduce((s, i) => s + i.estimadoUsd, 0)
  // Si toda la selección cae en la misma caja, el egreso se linkea a ese envío y
  // "pagado" ahí lo va a contar. Mezclando cajas (o piezas sin asignar) queda suelto.
  const envioIds = new Set(seleccionados.map(i => i.envioId))
  const envioUnico = envioIds.size === 1 ? seleccionados[0]?.envioId ?? null : null

  const todosIds = items.map(i => i.id)
  const todoSeleccionado = items.length > 0 && todosIds.every(id => selected.has(id))
  const algoSeleccionado = !todoSeleccionado && todosIds.some(id => selected.has(id))

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    for (const id of selected) fd.append('itemIds', String(id))
    startTransition(async () => {
      await action(fd)
      setSelected(new Set())
      ;(e.currentTarget as HTMLFormElement).reset()
    })
  }

  const contenido = (
    <>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        {/* Un solo tilde para agarrar TODO el envío/lista de una — sin esto había que armar
            un pago único para todo tildando pedido por pedido. */}
        <div className="px-4 py-2.5 bg-blue-50/50 border-b border-gray-100 flex items-center gap-3">
          <input
            type="checkbox"
            checked={todoSeleccionado}
            ref={el => { if (el) el.indeterminate = algoSeleccionado }}
            onChange={e => toggleGrupo(todosIds, e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm font-semibold text-gray-700">Seleccionar todo</span>
          <span className="text-xs text-gray-400">
            {items.length} {items.length === 1 ? 'ítem' : 'ítems'} en {grupos.length}{' '}
            {grupos.length === 1 ? 'pedido' : 'pedidos'} · estimado {usd(items.reduce((s, i) => s + i.estimadoUsd, 0))}
          </span>
        </div>
        <div className="divide-y divide-gray-100">
          {grupos.map(g => {
            const ids = g.items.map(i => i.id)
            const todos = ids.every(id => selected.has(id))
            const algunos = !todos && ids.some(id => selected.has(id))
            return (
              <div key={g.pedidoId}>
                <div className="px-4 py-2 bg-gray-50 flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={todos}
                    ref={el => { if (el) el.indeterminate = algunos }}
                    onChange={e => toggleGrupo(ids, e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm font-semibold text-gray-700">
                    #{g.pedidoId} {g.clientName}
                  </span>
                  <span className="text-xs text-gray-400">
                    {g.items.length} {g.items.length === 1 ? 'ítem' : 'ítems'} · estimado {usd(g.items.reduce((s, i) => s + i.estimadoUsd, 0))}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {g.items.map(i => (
                      <tr key={i.id} className="hover:bg-gray-50">
                        <td className="pl-9 pr-2 py-2 w-8">
                          <input
                            type="checkbox"
                            checked={selected.has(i.id)}
                            onChange={() => toggleItem(i.id)}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-gray-500 w-28">{i.sku ?? '—'}</td>
                        <td className="px-2 py-2 text-gray-900">{i.nombre}</td>
                        <td className="px-2 py-2 text-xs text-gray-400 w-32">
                          {i.envioId != null ? (i.envioNombre ?? `Envío #${i.envioId}`) : 'sin caja'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-500 w-16">×{i.quantity}</td>
                        <td className="pr-6 pl-2 py-2 text-right font-mono text-gray-400 w-24">{usd(i.estimadoUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </div>

      {/* Barra fija: qué se seleccionó y cuánto se pagó de verdad por eso. */}
      <div className="sticky bottom-4 bg-white rounded-xl shadow-lg border border-gray-200 p-4 flex flex-wrap items-end gap-3">
        <div className="text-sm text-gray-600 mr-auto">
          <span className="font-semibold">{seleccionados.length}</span> seleccionados
          {seleccionados.length > 0 && <span className="text-gray-400"> · estimado {usd(estimadoTotal)}</span>}
          {seleccionados.length > 0 && (
            <span className="block text-xs text-gray-400 mt-0.5">
              {envioUnico != null
                ? `Se anota como pagado de esa caja (${seleccionados[0].envioNombre ?? `Envío #${envioUnico}`}).`
                : 'Mezcla cajas distintas (o piezas sin caja): el egreso queda suelto, sin atribuir a ninguna en particular.'}
            </span>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Total pagado (USD)</label>
          <div className="flex items-center">
            <span className="text-sm text-gray-400 mr-1">$</span>
            <input
              type="number" name="monto" min={0.01} step="0.01" required
              className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
          <input type="date" name="fecha" defaultValue={today} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
          <select name="metodoPago" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="">—</option>
            {methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="min-w-[160px]">
          <label className="block text-xs font-medium text-gray-600 mb-1">Nota (opcional)</label>
          <input type="text" name="descripcion" placeholder="Ej: carrito 99rpm del 22/9" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <button
          type="submit"
          disabled={seleccionados.length === 0 || isPending}
          className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {isPending ? 'Guardando…' : 'Registrar compra'}
        </button>
      </div>
    </>
  )

  if (!collapsible) {
    return <form onSubmit={handleSubmit}>{contenido}</form>
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setAbierto(a => !a)}
        className="w-full flex items-center justify-between gap-3 bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-3 mb-4 hover:bg-gray-50 transition-colors text-left"
      >
        <span className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
          🧾 Costo real de las piezas ({items.length} {items.length === 1 ? 'pendiente' : 'pendientes'})
        </span>
        <span className="text-xs text-blue-600 font-medium shrink-0">{abierto ? 'Ocultar ▾' : 'Cargar ▸'}</span>
      </button>
      {abierto && (
        <>
          <p className="text-xs text-gray-400 mb-3">
            Tildá las que pagaste —una, varias, o &quot;Seleccionar todo&quot;— y poné el total: no
            hace falta precio exacto por pieza, el reparto es proporcional al estimado del catálogo.
          </p>
          <form onSubmit={handleSubmit}>{contenido}</form>
        </>
      )}
    </div>
  )
}
