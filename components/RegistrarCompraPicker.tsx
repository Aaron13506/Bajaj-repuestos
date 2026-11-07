'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import type { ItemPendienteCosto } from '@/lib/movimientos'
import type { ActionResult } from '@/lib/action-result'
import CampoFecha from '@/components/CampoFecha'

interface Props {
  items: ItemPendienteCosto[]
  action: (formData: FormData) => Promise<ActionResult>
  methods: readonly string[]
  // Modo embebido (en /envios/[id]): una sección con su título y los pedidos plegados, porque
  // casi siempre se paga todo junto. En /contabilidad/comprar el picker ES la página y va abierto.
  collapsible?: boolean
}

const usd = (n: number) => `$${n.toFixed(2)}`

export default function RegistrarCompraPicker({ items, action, methods, collapsible = false }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Qué clientes tienen el detalle por pieza desplegado. En la ficha del envío arrancan todos
  // cerrados: casi siempre se paga todo junto con "Seleccionar todo" y el precio por pieza o
  // por cliente es opcional, así que el detalle no tiene que ocupar la pantalla.
  const [desplegados, setDesplegados] = useState<Set<number>>(new Set())
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Unidades de cada línea que el proveedor cobró pero no mandó todavía (por id). Vive acá y no en
  // el form porque las filas de un cliente plegado no se renderizan y sus inputs se perderían.
  const [sinEnviar, setSinEnviar] = useState<Record<number, string>>({})
  // `isPending` recién se ve en el próximo render: un segundo submit que entre antes pasaría
  // igual. El ref lo corta en el mismo tick.
  const enVuelo = useRef(false)

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

  function toggleDesplegado(pedidoId: number) {
    setDesplegados(prev => {
      const next = new Set(prev)
      if (next.has(pedidoId)) next.delete(pedidoId)
      else next.add(pedidoId)
      return next
    })
  }

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
    if (enVuelo.current) return
    // El form se captura ACÁ: React anula `e.currentTarget` al terminar el dispatch, así que
    // después del `await` ya es null y `.reset()` tiraba un TypeError aunque la compra sí
    // se hubiera guardado.
    const form = e.currentTarget
    // Se valida al registrar (no con el botón gris): así el motivo se lee al lado del botón.
    if (selected.size === 0) {
      setError('Tildá al menos una pieza: el monto se reparte entre las que elijas.')
      return
    }
    const fd = new FormData(form)
    for (const id of selected) {
      fd.append('itemIds', String(id))
      if (sinEnviar[id]?.trim()) fd.set(`sinEnviar_${id}`, sinEnviar[id].trim())
    }
    enVuelo.current = true
    setError(null)
    startTransition(async () => {
      try {
        const r = await action(fd)
        if (r.ok) {
          setSelected(new Set())
          setSinEnviar({})
          form.reset()
        } else {
          // La selección y lo tipeado quedan como estaban: si la lista estaba vieja, lo que
          // hay que hacer es recargarla, no volver a armar todo.
          setError(r.error)
        }
      } catch {
        setError('No se pudo registrar la compra. Revisá tu conexión y probá de nuevo.')
      } finally {
        enVuelo.current = false
      }
    })
  }

  const contenido = (
    <>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto mb-4">
        {collapsible && (
          <div className="px-4 sm:px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Registrar lo que pagaste</h2>
            <p className="text-sm text-gray-600">
              Elegí lo que cubre el pago: todo, un pedido o piezas sueltas. El monto se reparte en proporción al
              estimado, como en Contabilidad → Comprar. Si el proveedor cobró algo que no mandó, desplegá el
              pedido y anotalo en «no mandó»: la caja no lo va a esperar al llegar.
            </p>
          </div>
        )}
        {/* Un solo tilde para agarrar TODO el envío/lista de una — sin esto había que armar
            un pago único para todo tildando pedido por pedido. */}
        <label className="px-4 py-2.5 bg-blue-50/50 border-b border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer">
          <input
            type="checkbox"
            checked={todoSeleccionado}
            ref={el => { if (el) el.indeterminate = algoSeleccionado }}
            onChange={e => toggleGrupo(todosIds, e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm font-semibold text-gray-700">Seleccionar todo</span>
          <span className="text-xs text-gray-500">
            {items.length} {items.length === 1 ? 'ítem' : 'ítems'} en {grupos.length}{' '}
            {grupos.length === 1 ? 'pedido' : 'pedidos'} · estimado {usd(items.reduce((s, i) => s + i.estimadoUsd, 0))}
          </span>
        </label>
        <div className="divide-y divide-gray-100">
          {grupos.map(g => {
            const ids = g.items.map(i => i.id)
            const todos = ids.every(id => selected.has(id))
            const algunos = !todos && ids.some(id => selected.has(id))
            const detalle = !collapsible || desplegados.has(g.pedidoId)
            const seleccionadosGrupo = ids.filter(id => selected.has(id)).length
            return (
              <div key={g.pedidoId}>
                <div className="px-2 py-1 bg-gray-50 flex items-center gap-2">
                  <label className="inline-flex items-center justify-center size-8 shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar todo el pedido #${g.pedidoId} (${g.clientName})`}
                      checked={todos}
                      ref={el => { if (el) el.indeterminate = algunos }}
                      onChange={e => toggleGrupo(ids, e.target.checked)}
                      className="size-4 rounded border-gray-300"
                    />
                  </label>
                  {collapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleDesplegado(g.pedidoId)}
                      aria-expanded={detalle}
                      className="flex flex-wrap items-center gap-x-2 min-h-8 text-left flex-1 min-w-0 group"
                    >
                      <span aria-hidden="true" className={`text-gray-500 text-xs transition-transform shrink-0 ${detalle ? 'rotate-90' : ''}`}>▶</span>
                      <span className="text-sm font-semibold text-gray-700 group-hover:text-blue-600">
                        #{g.pedidoId} {g.clientName}
                      </span>
                      <span className="text-xs text-gray-500">
                        {g.items.length} {g.items.length === 1 ? 'ítem' : 'ítems'} · estimado {usd(g.items.reduce((s, i) => s + i.estimadoUsd, 0))}
                        {!detalle && seleccionadosGrupo > 0 && ` · ${seleccionadosGrupo} tildados`}
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-gray-700">
                        #{g.pedidoId} {g.clientName}
                      </span>
                      <span className="text-xs text-gray-500">
                        {g.items.length} {g.items.length === 1 ? 'ítem' : 'ítems'} · estimado {usd(g.items.reduce((s, i) => s + i.estimadoUsd, 0))}
                      </span>
                    </>
                  )}
                </div>
                {detalle && <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {g.items.map(i => (
                      <tr key={i.id} className="hover:bg-gray-50">
                        <td className="pl-7 pr-1 py-0.5 w-8">
                          {/* El <label> agranda el área a 32 px; la casilla sigue de 16. */}
                          <label className="inline-flex items-center justify-center size-8 cursor-pointer">
                            <input
                              type="checkbox"
                              aria-label={i.nombre}
                              checked={selected.has(i.id)}
                              onChange={() => toggleItem(i.id)}
                              className="size-4 rounded border-gray-300"
                            />
                          </label>
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-gray-500 w-28">{i.sku ?? '—'}</td>
                        <td className="px-2 py-2 text-gray-900">{i.nombre}</td>
                        <td className="px-2 py-2 text-xs text-gray-500 w-32">
                          {i.envioId != null ? (i.envioNombre ?? `Envío #${i.envioId}`) : 'sin caja'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-500 w-16">×{i.quantity}</td>
                        <td className="px-2 py-2 w-28">
                          {i.admiteSinEnviar && selected.has(i.id) && (
                            <label className="flex items-center justify-end gap-1 text-xs text-gray-600" title="Unidades que el proveedor cobró pero no mandó todavía: la caja no las espera al llegar">
                              no mandó
                              <input
                                type="number" min={0} max={i.quantity} step={1} inputMode="numeric"
                                value={sinEnviar[i.id] ?? ''}
                                onChange={e => setSinEnviar(prev => ({ ...prev, [i.id]: e.target.value }))}
                                placeholder="0"
                                aria-label={`Unidades de ${i.nombre} que el proveedor no mandó`}
                                className="w-14 min-h-8 border border-gray-300 rounded-md px-1.5 py-0.5 text-right font-mono text-sm"
                              />
                            </label>
                          )}
                        </td>
                        <td className="pr-6 pl-2 py-2 text-right font-mono text-gray-500 w-24">{usd(i.estimadoUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>}
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      {/* Barra fija: qué se seleccionó y cuánto se pagó de verdad por eso. */}
      <div className="sticky bottom-4 bg-white rounded-xl shadow-lg border border-gray-200 p-4 flex flex-wrap items-end gap-3">
        <div className="text-sm text-gray-600 mr-auto">
          <span className="font-semibold">{seleccionados.length}</span> seleccionados
          {seleccionados.length > 0 && <span className="text-gray-500"> · estimado {usd(estimadoTotal)}</span>}
          {seleccionados.length > 0 && (
            <span className="block text-xs text-gray-500 mt-0.5">
              {envioUnico != null
                ? `Se anota como pagado de esa caja (${seleccionados[0].envioNombre ?? `Envío #${envioUnico}`}).`
                : 'Mezcla cajas distintas (o piezas sin caja): el egreso queda suelto, sin atribuir a ninguna en particular.'}
            </span>
          )}
        </div>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Total pagado (USD)</span>
          <div className="flex items-center">
            <span className="text-sm text-gray-500 mr-1">$</span>
            <input
              type="number" name="monto" min={0.01} step="0.01" required
              className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Fecha</span>
          <CampoFecha name="fecha" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Método de pago</span>
          <select name="metodoPago" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="">—</option>
            {methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="min-w-[160px]">
          <span className="block text-xs font-medium text-gray-600 mb-1">Nota (opcional)</span>
          <input type="text" name="descripcion" placeholder="Ej: carrito 99rpm del 22/9" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </label>
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center min-h-10 bg-blue-600 text-white px-5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-wait transition-colors"
        >
          {isPending ? 'Guardando…' : 'Registrar compra'}
        </button>
      </div>
    </>
  )

  return <form onSubmit={handleSubmit}>{contenido}</form>
}
