'use client'

import { useActionState, useMemo, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { resolverLista, cargarPedido, type ListaResuelta } from '@/app/(pages)/simular/actions'
import { calcExpress } from '@/lib/express'
import type { ConfigMap, EnvioItemInput } from '@/lib/calc'
import type { PedidoOpcion } from '@/components/CompararCompra'

// ─────────────────────────────────────────────────────────────────────────────
// ¿Entra por express, y a cuánto lo vendo?
//
// Express es Shoppre despachando directo a Venezuela: más rápido, más caro, y con un tope de
// landed por paquete (Config.express_tope_usd). La pregunta del día a día es justo esa:
// "esto que me pidieron, ¿entra?", y si entra, "¿cuánto le cobro?".
//
// El flete sale solo de la tabla de Shoppre a Venezuela (la trae el cron). Si Shoppre ya
// cobró, se escribe lo que cobró y pisa a la tabla. Todo se recalcula en el navegador con
// `calcExpress`, que es `calcEnvio` en modo express: el mismo número que va a dar la caja.
// ─────────────────────────────────────────────────────────────────────────────

interface Pieza {
  productId: number
  sku: string
  nombre: string
  qty: number
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
}

const listaVacia: ListaResuelta = {
  ok: false, lineas: [], precios: [], noEncontrados: [], sinCodigo: [], errores: [], avisos: [],
}

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`

export default function SimuladorExpress({ pedidos, cfg }: { pedidos: PedidoOpcion[]; cfg: ConfigMap }) {
  const [fuente, setFuente] = useState<'pedido' | 'lista'>('pedido')
  const [lista, formAction] = useActionState(resolverLista, listaVacia)
  const [resuelta, setResuelta] = useState<ListaResuelta>(listaVacia)
  const [piezas, setPiezas] = useState<Pieza[]>([])
  const [pedidoId, setPedidoId] = useState<number | null>(null)
  const [cargando, startCarga] = useTransition()
  const [flete, setFlete] = useState('')
  const [margenTxt, setMargenTxt] = useState('')

  function adoptar(r: ListaResuelta) {
    setResuelta(r)
    setPiezas(r.lineas.map(l => ({
      productId: l.productId, sku: l.sku, nombre: l.nameEs, qty: l.qty,
      weightGrams: l.weightGrams, dimL: l.dimL, dimA: l.dimA, dimH: l.dimH, priceInr: l.priceInr,
    })))
  }

  // Mismo patrón que CompararCompra: la lista pegada se adopta al cambiar, sin efecto.
  const [listaAdoptada, setListaAdoptada] = useState(lista)
  if (lista !== listaAdoptada) {
    setListaAdoptada(lista)
    if (lista.lineas.length > 0 || lista.errores.length > 0) adoptar(lista)
  }

  function elegirPedido(id: number | null) {
    setPedidoId(id)
    if (id == null) { adoptar(listaVacia); return }
    startCarga(async () => adoptar(await cargarPedido(id)))
  }

  // Vacío es "usá la tabla"; un texto que no es número no pisa nada (y se marca en rojo).
  const fleteNum = flete.trim() === '' ? null : parseFloat(flete)
  const fleteInvalido = fleteNum != null && !(Number.isFinite(fleteNum) && fleteNum >= 0)
  const margenNum = margenTxt.trim() === '' ? null : parseFloat(margenTxt)
  const margenInvalido = margenNum != null && !(Number.isFinite(margenNum) && margenNum >= 0 && margenNum < 95)

  const items: EnvioItemInput[] = useMemo(() => piezas.map(p => ({
    pedidoId: 0,
    productId: p.productId,
    name: p.nombre,
    weightGrams: p.weightGrams,
    dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
    priceInr: p.priceInr,
    quantity: p.qty,
    origen: 'india',
    inbound: 'shoppre',
    supplierId: null,
  })), [piezas])

  const r = useMemo(() => items.length === 0 ? null : calcExpress(items, cfg, {
    fleteUsd: fleteInvalido ? null : fleteNum,
    margen: margenNum != null && !margenInvalido ? margenNum / 100 : undefined,
  }), [items, cfg, fleteNum, fleteInvalido, margenNum, margenInvalido])

  const sinPrecio = piezas.filter(p => p.priceInr == null)

  function setQty(productId: number, qty: number) {
    if (!Number.isFinite(qty) || qty < 1) return
    setPiezas(prev => prev.map(p => (p.productId === productId ? { ...p, qty: Math.round(qty) } : p)))
  }
  function quitar(productId: number) {
    setPiezas(prev => prev.filter(p => p.productId !== productId))
  }

  return (
    <div className="space-y-5">
      {/* ── La canasta ─────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-gray-900">Qué quiere traer</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Precio base de 99rpm en ₹, por el depósito de Shoppre, directo a Venezuela.
            </p>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {(['pedido', 'lista'] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFuente(f)}
                className={`px-3 py-1.5 ${fuente === f ? 'bg-blue-50 text-blue-800 font-medium' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                {f === 'pedido' ? '📄 Un presupuesto' : '📋 Pegar una lista'}
              </button>
            ))}
          </div>
        </div>

        {fuente === 'pedido' ? (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={pedidoId ?? ''}
              onChange={e => elegirPedido(e.target.value === '' ? null : parseInt(e.target.value))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white w-full sm:w-auto sm:min-w-72"
            >
              <option value="">Elegí un presupuesto…</option>
              {pedidos.map(p => (
                <option key={p.id} value={p.id}>#{p.id} · {p.clientName} · {p.pieceCount} pzas · {p.status}</option>
              ))}
            </select>
            {cargando && <span className="text-xs text-gray-400">Resolviendo piezas…</span>}
          </div>
        ) : (
          <form action={formAction} className="space-y-3">
            <textarea
              name="lista"
              rows={3}
              placeholder={'JR161036 x2\nJS121064'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
            <BotonLista />
          </form>
        )}

        {resuelta.errores.map((e, i) => (
          <p key={i} className="text-xs text-red-700 bg-red-50 px-3 py-2 rounded-lg mt-3">⚠️ {e}</p>
        ))}
        {resuelta.noEncontrados.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mt-3">
            No están en el catálogo: <span className="font-mono">{resuelta.noEncontrados.join(', ')}</span>. No entran a la cuenta.
          </p>
        )}
        {resuelta.avisos.map((a, i) => (
          <p key={i} className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg mt-2">{a}</p>
        ))}
        {sinPrecio.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mt-2">
            Sin precio en ₹: {sinPrecio.map(p => p.sku).join(', ')}. Entran con producto $0, así que el landed es un piso.
          </p>
        )}
      </section>

      {r && (
        <>
          {/* ── El veredicto: ¿entra en el tope? ───────────────────────────── */}
          <section className={`rounded-xl border-2 p-6 ${r.excede ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className={`text-lg font-bold ${r.excede ? 'text-red-800' : 'text-green-800'}`}>
                {r.excede
                  ? `Te pasaste ${usd(-r.holguraUsd)} del tope`
                  : `Entra. Te quedan ${usd(r.holguraUsd)}`}
              </h2>
              <span className="text-sm text-gray-600 font-mono">
                {usd(r.landedUsd)} de {usd(r.topeUsd)}
              </span>
            </div>
            <div className="mt-3 h-3 rounded-full bg-white overflow-hidden border border-gray-200">
              <div
                className={`h-full ${r.excede ? 'bg-red-500' : 'bg-green-500'}`}
                style={{ width: `${Math.min(100, (r.landedUsd / r.topeUsd) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-gray-600 mt-3">
              {r.excede
                ? 'Sacá piezas hasta bajar del tope, o mandalo en dos paquetes (cada uno paga su propio flete).'
                : <>Entran ≈ <b>{usd(r.productoQueEntraUsd)}</b> más de producto mientras el flete no cambie de escalón
                  {r.kgHastaProximoEscalon != null && <> (quedan <b>{kg(r.kgHastaProximoEscalon)}</b> cobrables en este escalón)</>}.</>}
            </p>
            {r.sinPeso.length > 0 && (
              <p className="text-xs text-amber-800 mt-2">
                ⚠️ Sin peso: {r.sinPeso.join(', ')}. El flete es un piso: el paquete real pesa más.
              </p>
            )}
          </section>

          {/* ── El paquete y la plata ──────────────────────────────────────── */}
          <section className="grid gap-5 md:grid-cols-2">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="font-semibold text-gray-900 mb-3">El paquete</h3>
              <dl className="text-sm space-y-1.5">
                <Fila k="Peso real" v={kg(r.envio.air.realKg)} />
                <Fila k="Peso volumétrico" v={kg(r.envio.air.volKg)} />
                <Fila k="Cobrable" v={kg(r.envio.air.chargeableKg)} fuerte />
                {r.envio.air.binding === 'volume' && (
                  <p className="text-[11px] text-amber-700">Manda el volumen: una caja más chica baja el flete.</p>
                )}
                <hr className="my-2 border-gray-100" />
                <Fila k="Producto" v={usd(r.envio.productCostUsd)} />
                <Fila k={fleteNum != null && !fleteInvalido ? 'Flete (lo que cobró Shoppre)' : 'Flete (tabla Shoppre → VEN)'} v={usd(r.envio.airUsd)} />
                <Fila k="Seguro Shoppre" v={usd(r.envio.insuranceUsd)} />
                <Fila k="Processing Shoppre" v={usd(r.envio.processingUsd)} />
                <Fila k="Landed del paquete" v={usd(r.landedUsd)} fuerte />
              </dl>
              <label className="block mt-4 text-xs text-gray-500">
                Flete que cobró Shoppre (USD, processing incluido)
                <input
                  value={flete}
                  onChange={e => setFlete(e.target.value)}
                  inputMode="decimal"
                  placeholder="vacío = tabla"
                  className={`mt-1 w-full border rounded-lg px-3 py-1.5 text-sm font-mono ${fleteInvalido ? 'border-red-400' : 'border-gray-300'}`}
                />
              </label>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="font-semibold text-gray-900 mb-3">Precio al cliente</h3>
              <dl className="text-sm space-y-1.5">
                <Fila k="Margen" v={`${(r.margen * 100).toFixed(1)}%`} />
                <Fila k="Precio (dólares reales)" v={usd(r.precioUsd)} fuerte />
                {r.precioUsdBcv != null && <Fila k="Precio a cotizar (dólar BCV)" v={usd(r.precioUsdBcv)} />}
                <Fila k="Ganancia" v={usd(r.gananciaUsd)} />
              </dl>
              <label className="block mt-4 text-xs text-gray-500">
                Margen (%)
                <input
                  value={margenTxt}
                  onChange={e => setMargenTxt(e.target.value)}
                  inputMode="decimal"
                  placeholder={`vacío = Config (${(r.margen * 100).toFixed(0)}%)`}
                  className={`mt-1 w-full border rounded-lg px-3 py-1.5 text-sm font-mono ${margenInvalido ? 'border-red-400' : 'border-gray-300'}`}
                />
              </label>
              <p className="text-[11px] text-gray-400 mt-3">
                El tope es sobre el landed, no sobre el precio: venderlo por encima de {usd(r.topeUsd)} no importa.
              </p>
            </div>
          </section>

          {/* ── Por pieza ──────────────────────────────────────────────────── */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Pieza</th>
                  <th className="text-right px-4 py-2">Cant.</th>
                  <th className="text-right px-4 py-2">Peso u.</th>
                  <th className="text-right px-4 py-2">Landed u.</th>
                  <th className="text-right px-4 py-2">Precio u.</th>
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {piezas.map((p, i) => {
                  const l = r.lineas[i]
                  return (
                    <tr key={p.productId}>
                      <td className="px-4 py-2">
                        <span className="font-mono text-xs text-gray-500">{p.sku}</span>{' '}
                        <span className="text-gray-800">{p.nombre}</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          value={p.qty}
                          onChange={e => setQty(p.productId, parseInt(e.target.value))}
                          className="w-16 border border-gray-300 rounded px-2 py-1 text-right"
                        />
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-gray-600">
                        {p.weightGrams != null ? `${p.weightGrams} g` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{usd(l.landedUsd / l.quantity)}</td>
                      <td className="px-4 py-2 text-right font-mono font-semibold">{usd(l.precioUnitUsd)}</td>
                      <td className="px-2 text-right">
                        <button type="button" onClick={() => quitar(p.productId)} className="text-gray-400 hover:text-red-600" title="Quitar">
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}

function Fila({ k, v, fuerte }: { k: string; v: string; fuerte?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500">{k}</dt>
      <dd className={`font-mono ${fuerte ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{v}</dd>
    </div>
  )
}

function BotonLista() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
    >
      {pending ? 'Buscando…' : 'Calcular'}
    </button>
  )
}
