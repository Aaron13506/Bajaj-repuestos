'use client'

import { useMemo, useState } from 'react'
import { calcEnvio, type EnvioItemInput, type ConfigMap } from '@/lib/calc'

export interface SimProduct {
  id: number
  nameEs: string
  bajajCode: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  price: number
}

export interface SimCostPiece {
  name: string
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  quantity: number
}

export interface SimPedido {
  id: number
  clientName: string
  status: string
  /** Envíos donde ya hay ítems de este presupuesto (puede estar repartido en varios). */
  envioIds: number[]
  saleTotal: number
  pieceCount: number
  /** Piezas físicas ya resueltas (los conjuntos vienen expandidos a sus piezas reales). */
  costPieces: SimCostPiece[]
}

interface ManualLine {
  product: SimProduct
  quantity: number
}

interface Props {
  products: SimProduct[]
  pedidos: SimPedido[]
  cfg: ConfigMap
}

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`

// Guía de punto dulce sobre la curva real de ShipGlobal Duty Free (member).
function airTierHint(chargeableKg: number): { tone: 'good' | 'info'; text: string } | null {
  if (chargeableKg <= 0) return null
  if (chargeableKg < 11) {
    const falta = 11 - chargeableKg
    return {
      tone: 'info',
      text: `Te faltan ${falta.toFixed(1)} kg cobrables para el punto dulce (11 kg → ~1 500 INR/kg). El kg 11 cuesta casi nada (+101 INR vs 10 kg).`,
    }
  }
  if (chargeableKg < 16) {
    return { tone: 'info', text: 'En el punto dulce base (~1 500 INR/kg). Llegar a 16 kg baja a ~1 456 INR/kg (mejora chica).' }
  }
  if (chargeableKg < 20) {
    return { tone: 'info', text: 'Buen tramo (~1 456 INR/kg). 20 kg baja a ~1 421 INR/kg, casi el tope de eficiencia.' }
  }
  return { tone: 'good', text: 'Estás en el tramo más eficiente de ShipGlobal (~1 421 INR/kg).' }
}

export default function SimuladorEnvio({ products, pedidos, cfg }: Props) {
  const [selectedPedidoIds, setSelectedPedidoIds] = useState<number[]>([])
  const [manual, setManual] = useState<ManualLine[]>([])
  const [search, setSearch] = useState('')

  const selectedPedidos = useMemo(
    () => selectedPedidoIds.map(id => pedidos.find(p => p.id === id)!).filter(Boolean),
    [selectedPedidoIds, pedidos]
  )

  const availablePedidos = pedidos.filter(p => !selectedPedidoIds.includes(p.id))

  function addPedido(id: number) {
    setSelectedPedidoIds(prev => (prev.includes(id) ? prev : [...prev, id]))
  }
  function removePedido(id: number) {
    setSelectedPedidoIds(prev => prev.filter(x => x !== id))
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return []
    const q = search.toLowerCase()
    return products
      .filter(
        p =>
          (p.nameEs.toLowerCase().includes(q) || p.bajajCode?.toLowerCase().includes(q)) &&
          !manual.find(c => c.product.id === p.id)
      )
      .slice(0, 8)
  }, [search, products, manual])

  function addProduct(p: SimProduct) {
    if (manual.find(c => c.product.id === p.id)) return
    setManual(prev => [...prev, { product: p, quantity: 1 }])
    setSearch('')
  }
  function updateQty(id: number, qty: number) {
    if (qty < 1 || isNaN(qty)) return
    setManual(prev => prev.map(c => (c.product.id === id ? { ...c, quantity: qty } : c)))
  }
  function removeManual(id: number) {
    setManual(prev => prev.filter(c => c.product.id !== id))
  }

  // Aplanar presupuestos + piezas sueltas en items para el mismo cálculo que un envío real.
  // Los conjuntos ya vienen expandidos a sus piezas reales desde el servidor.
  const items: EnvioItemInput[] = [
    ...selectedPedidos.flatMap(ped =>
      ped.costPieces.map(piece => ({
        pedidoId: ped.id,
        productId: 0,
        name: piece.name,
        weightGrams: piece.weightGrams,
        dimL: piece.dimL,
        dimA: piece.dimA,
        dimH: piece.dimH,
        priceInr: piece.priceInr,
        quantity: piece.quantity,
      }))
    ),
    ...manual.map(c => ({
      pedidoId: 0,
      productId: c.product.id,
      name: c.product.nameEs,
      weightGrams: c.product.weightGrams,
      dimL: c.product.dimL,
      dimA: c.product.dimA,
      dimH: c.product.dimH,
      priceInr: c.product.priceInr,
      quantity: c.quantity,
    })),
  ]

  const calc = useMemo(() => calcEnvio(items, cfg), [JSON.stringify(items), cfg])

  const isEmpty = items.length === 0

  // Venta: presupuestos usan su salePrice (ya sumado); piezas sueltas usan precio de catálogo
  const saleTotal =
    selectedPedidos.reduce((s, ped) => s + ped.saleTotal, 0) +
    manual.reduce((s, c) => s + c.product.price * c.quantity, 0)

  const shippingEst = calc.airUsd + calc.maritimeUsd
  const anyMissing = calc.lines.some(l => l.missingWeight || l.missingDims)
  const ratioPct = calc.ratioVW != null ? calc.ratioVW * 100 : null
  const tierHint = airTierHint(calc.chargeableKg)
  const fmtBound =
    calc.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  // Landed por presupuesto
  const landedByPedido = new Map<number, number>()
  for (const l of calc.lines) {
    landedByPedido.set(l.pedidoId, (landedByPedido.get(l.pedidoId) ?? 0) + l.landedUsd)
  }

  function pedidoPieces(ped: SimPedido) {
    return ped.pieceCount
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* ── Izquierda: armar el supuesto envío ── */}
      <div className="space-y-4">
        {/* Presupuestos */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-900 mb-1">Agregar presupuesto</h2>
          <p className="text-xs text-gray-400 mb-3">
            Seleccioná presupuestos ya creados para simular cómo saldría traerlos juntos en un envío.
          </p>

          {availablePedidos.length === 0 ? (
            <p className="text-sm text-gray-400 py-3">
              {pedidos.length === 0
                ? 'No hay presupuestos creados todavía.'
                : 'Ya agregaste todos los presupuestos disponibles.'}
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto divide-y divide-gray-50">
              {availablePedidos.map(ped => (
                <button
                  key={ped.id}
                  type="button"
                  onClick={() => addPedido(ped.id)}
                  className="w-full flex items-center justify-between px-2 py-2.5 text-left hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-gray-900">{ped.clientName}</span>
                    <span className="ml-2 text-xs text-gray-400">
                      #{ped.id} · {pedidoPieces(ped)} pzas · {ped.status}
                      {ped.envioIds.length > 0 && (
                        <span className="text-amber-600">
                          {' · ya en '}
                          {ped.envioIds.length === 1 ? 'envío' : 'envíos'} {ped.envioIds.map(id => `#${id}`).join(', ')}
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="text-sm text-blue-600 font-medium shrink-0">+ Agregar</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Presupuestos agregados */}
        {selectedPedidos.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">
              Presupuestos en el supuesto
              <span className="ml-2 text-xs font-normal text-gray-400">{selectedPedidos.length}</span>
            </h2>
            <div className="space-y-1">
              {selectedPedidos.map(ped => (
                <div key={ped.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{ped.clientName}</p>
                    <p className="text-xs text-gray-400">#{ped.id} · {pedidoPieces(ped)} pzas</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-mono text-gray-600">{usd(landedByPedido.get(ped.id) ?? 0)}</span>
                    <button
                      type="button"
                      onClick={() => removePedido(ped.id)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Piezas sueltas */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-900 mb-1">Agregar pieza suelta</h2>
          <p className="text-xs text-gray-400 mb-3">Opcional: sumá piezas extra que no estén en un presupuesto.</p>
          <div className="relative">
            <input
              type="text"
              placeholder="Buscar por nombre o código..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            {filtered.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg divide-y divide-gray-50 overflow-hidden">
                {filtered.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addProduct(p)}
                    className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
                  >
                    <div>
                      <span className="text-sm font-medium text-gray-900">{p.nameEs}</span>
                      {p.bajajCode && <span className="ml-2 text-xs font-mono text-gray-400">{p.bajajCode}</span>}
                    </div>
                    <span className="text-xs text-gray-400">
                      {p.weightGrams != null ? `${p.weightGrams} g` : 'sin peso'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {manual.length > 0 && (
            <div className="mt-4 space-y-1">
              {manual.map(({ product: p, quantity }) => (
                <div key={p.id} className="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.nameEs}</p>
                    <p className="text-xs text-gray-400">
                      {p.bajajCode && <span className="font-mono">{p.bajajCode} · </span>}
                      {p.weightGrams != null ? `${p.weightGrams} g` : <span className="text-amber-600">sin peso</span>}
                    </p>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={e => updateQty(p.id, parseInt(e.target.value) || 1)}
                    className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => removeManual(p.id)}
                    className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                    title="Quitar"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Derecha: resultado del cálculo ── */}
      <div className="space-y-4">
        {isEmpty ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400">
            <p className="text-lg">Supuesto vacío</p>
            <p className="text-sm mt-1">Agregá presupuestos o piezas a la izquierda para ver el costo aproximado.</p>
          </div>
        ) : (
          <>
            {/* Peso cobrable */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Peso cobrable aéreo</h2>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Peso real (ΣW)</p>
                  <p className={`text-lg font-bold font-mono ${calc.binding === 'weight' ? 'text-green-700' : 'text-gray-900'}`}>{kg(calc.realKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Volumétrico (ΣV)</p>
                  <p className={`text-lg font-bold font-mono ${calc.binding === 'volume' ? 'text-red-700' : 'text-gray-900'}`}>{kg(calc.volKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
                  <p className="text-lg font-bold font-mono text-blue-700">{kg(calc.chargeableKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Aéreo / kg</p>
                  <p className="text-lg font-bold font-mono text-gray-900">{usd(calc.airPerKgUsd)}</p>
                </div>
              </div>
              {/* Utilización volumétrica */}
              {ratioPct != null && (
                <div className="mt-5">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-500">Utilización volumétrica (V/W) — meta 80–100%</span>
                    <span className="font-mono font-semibold text-gray-700">{ratioPct.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden relative">
                    <div className="absolute inset-y-0 bg-green-100" style={{ left: '80%', right: '0%' }} />
                    <div
                      className={`h-full rounded-full ${calc.binding === 'volume' ? 'bg-red-500' : ratioPct >= 80 ? 'bg-green-500' : 'bg-amber-400'}`}
                      style={{ width: `${Math.min(ratioPct, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs mt-2 text-gray-600">
                    {calc.binding === 'volume'
                      ? '⚠️ Te pasaste por volumen: el carrier cobra el volumétrico (> peso). Agregá piezas pesadas para volver a estar atado por peso, o tus precios fijos subcostean.'
                      : ratioPct >= 80
                        ? '✓ Buena utilización: estás llenando el volumen que ya pagás por peso.'
                        : 'Desperdiciás volumen pagado. Podés colar piezas voluminosas y ligeras (plásticos) casi gratis hasta llegar al 100%.'}
                  </p>
                </div>
              )}

              {tierHint && (
                <p className={`text-xs mt-3 px-3 py-2 rounded-lg ${tierHint.tone === 'good' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
                  {tierHint.text}
                </p>
              )}

              {anyMissing && (
                <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                  ⚠️ Algunas piezas no tienen peso o dimensiones cargadas — el cálculo las subestima.
                </p>
              )}
            </div>

            {/* Desglose de costo */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Costo aproximado (landed)</h2>
              <dl className="space-y-2 text-sm">
                <Row label="Costo de producto (India)" value={usd(calc.productCostUsd)} />
                <Row label={`Aéreo India→USA · ${calc.air.chargeableKg.toFixed(1)} kg cobrables`} value={usd(calc.airUsd)} />
                <Row label="Marítimo USA→VEN (volumen)" value={usd(calc.maritimeUsd)} />
                <Row label="Seguro" value={usd(calc.insuranceUsd)} />
                <Row label="Processing" value={usd(calc.processingUsd)} />
                <div className="flex justify-between pt-3 mt-2 border-t-2 border-gray-200">
                  <dt className="font-bold text-gray-900">Costo total landed</dt>
                  <dd className="font-bold text-xl font-mono text-blue-700">{usd(calc.landedUsd)}</dd>
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <dt>Solo flete (aéreo + marítimo)</dt>
                  <dd className="font-mono">{usd(shippingEst)}</dd>
                </div>
                {saleTotal > 0 && (
                  <>
                    <Row label="Venta (suma de presupuestos)" value={usd(saleTotal)} />
                    <div className="flex justify-between">
                      <dt className="font-semibold text-gray-700">Margen bruto</dt>
                      <dd className={`font-semibold font-mono ${saleTotal - calc.landedUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {usd(saleTotal - calc.landedUsd)}{' '}
                        <span className="text-xs text-gray-400">
                          ({((1 - calc.landedUsd / saleTotal) * 100).toFixed(0)}%)
                        </span>
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>

            {/* Desglose por pieza */}
            <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <summary className="px-6 py-3 bg-gray-50 cursor-pointer text-sm font-semibold text-gray-500 uppercase tracking-wide">
                Desglose por pieza ({calc.lines.length})
              </summary>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-6 py-2 font-semibold">Pieza</th>
                    <th className="text-right px-3 py-2 font-semibold">Real</th>
                    <th className="text-right px-3 py-2 font-semibold">Vol.</th>
                    <th className="text-right px-3 py-2 font-semibold">Aéreo</th>
                    <th className="text-right px-3 py-2 font-semibold">Marít.</th>
                    <th className="text-right px-4 py-2 font-semibold">Landed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {calc.lines.map((l, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-2.5">
                        <span className="text-gray-900">{l.name}</span>
                        {l.quantity > 1 && <span className="text-xs text-gray-400"> ×{l.quantity}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">{l.realKg.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">{l.volKg.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">{usd(l.airUsd)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">{usd(l.maritimeUsd)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-gray-900">{usd(l.landedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono text-gray-800">{value}</dd>
    </div>
  )
}
