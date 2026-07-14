import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import { calcEnvio, type EnvioItemInput, type ConfigMap } from '@/lib/calc'
import { makeProductLookup, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import {
  assignPedido,
  removePedido,
  deleteEnvio,
  saveEstimate,
} from '../actions'

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

export default async function EnvioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [envio, cfgRows, sinAsignar, allProducts] = await Promise.all([
    db.envio.findUnique({
      where: { id },
      include: {
        pedidos: {
          include: { items: { include: { product: true } } },
          orderBy: { id: 'asc' },
        },
      },
    }),
    db.config.findMany(),
    db.pedido.findMany({
      where: { envioId: null },
      include: { items: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.product.findMany({
      select: { nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true },
    }),
  ])

  if (!envio) notFound()

  const cfg = cfgRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})

  // Lookup para resolver piezas de conjuntos a su producto real (por bajajCode).
  const lookup = makeProductLookup(allProducts as ProductCost[])

  // Aplanar todas las piezas del envío. Los conjuntos se expanden a sus piezas reales
  // para costearlos por las piezas que llevan, no por el ensamble entero.
  const allPieces = envio.pedidos.flatMap(ped =>
    ped.items.flatMap(it =>
      expandCostPieces(
        it.product as ProductCost,
        it.quantity,
        it.bundleItems as BundlePiece[] | null,
        lookup,
      ).map(piece => ({ pedidoId: ped.id, productId: it.productId, ...piece }))
    )
  )

  const items: EnvioItemInput[] = allPieces.map(p => ({
    pedidoId: p.pedidoId,
    productId: p.productId,
    name: p.name,
    weightGrams: p.weightGrams,
    dimL: p.dimL,
    dimA: p.dimA,
    dimH: p.dimH,
    priceInr: p.priceInr,
    quantity: p.quantity,
  }))

  const calc = calcEnvio(items, cfg)

  // Lista de compra: consolida las piezas por SKU (o nombre si no tiene SKU) sumando
  // cantidades, para saber exactamente qué y cuánto comprar en India.
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  interface BuyRow {
    sku: string | null
    name: string
    qty: number
    unitInr: number | null
    totalInr: number
    missingPrice: boolean
  }
  const buyMap = new Map<string, BuyRow>()
  for (const p of allPieces) {
    const key = p.sku ?? p.name
    let row = buyMap.get(key)
    if (!row) {
      row = { sku: p.sku, name: p.name, qty: 0, unitInr: p.priceInr, totalInr: 0, missingPrice: false }
      buyMap.set(key, row)
    }
    row.qty += p.quantity
    if (p.priceInr != null) {
      row.totalInr += p.priceInr * p.quantity
      if (row.unitInr == null) row.unitInr = p.priceInr
    } else {
      row.missingPrice = true
    }
  }
  const buyList = Array.from(buyMap.values()).sort((a, b) => b.totalInr - a.totalInr)
  const buyTotalInr = buyList.reduce((s, r) => s + r.totalInr, 0)
  const buyTotalUsd = buyTotalInr / inrUsd
  const buyUnits = buyList.reduce((s, r) => s + r.qty, 0)

  // Ingreso de venta (suma de salePrice) por pedido y total
  const saleByPedido = new Map<number, number>()
  let saleTotal = 0
  for (const ped of envio.pedidos) {
    const t = ped.items.reduce((s, it) => s + parseFloat(it.salePrice.toString()) * it.quantity, 0)
    saleByPedido.set(ped.id, t)
    saleTotal += t
  }

  // Landed por pedido
  const landedByPedido = new Map<number, number>()
  for (const l of calc.lines) {
    landedByPedido.set(l.pedidoId, (landedByPedido.get(l.pedidoId) ?? 0) + l.landedUsd)
  }

  const anyMissing = calc.lines.some(l => l.missingWeight || l.missingDims)
  const tierHint = airTierHint(calc.chargeableKg)
  const ratioPct = calc.ratioVW != null ? calc.ratioVW * 100 : null
  const shippingEst = calc.airUsd + calc.maritimeUsd
  const fmtBound =
    calc.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/envios" className="text-gray-400 hover:text-gray-600 text-sm">Envíos</Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">#{envio.id}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{envio.nombre ?? `Envío #${envio.id}`}</h1>
          {envio.notas && <p className="text-sm text-gray-500 mt-1">{envio.notas}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {calc.chargeableKg > 0 && (
            <form action={saveEstimate.bind(null, envio.id, shippingEst)}>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Guardar flete est. ({usd(shippingEst)})
              </button>
            </form>
          )}
          <DeleteButton
            action={deleteEnvio.bind(null, envio.id)}
            confirmMessage={`¿Eliminar el envío "${envio.nombre ?? `#${envio.id}`}"? Los presupuestos quedarán libres.`}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 mb-8">
          <p className="text-lg">Este envío está vacío</p>
          <p className="text-sm mt-1">Agregá presupuestos abajo para calcular el peso cobrable y el costo.</p>
        </div>
      ) : (
        <>
          {/* Resumen de caja: peso cobrable */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Peso cobrable aéreo</h2>
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-400 mb-1">Peso real (ΣW)</p>
                <p className={`text-xl font-bold font-mono ${calc.binding === 'weight' ? 'text-green-700' : 'text-gray-900'}`}>{kg(calc.realKg)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Volumétrico (ΣV)</p>
                <p className={`text-xl font-bold font-mono ${calc.binding === 'volume' ? 'text-red-700' : 'text-gray-900'}`}>{kg(calc.volKg)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
                <p className="text-xl font-bold font-mono text-blue-700">{kg(calc.chargeableKg)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Aéreo / kg</p>
                <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.airPerKgUsd)}</p>
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
                  {/* zona dulce 80-100% */}
                  <div className="absolute inset-y-0 bg-green-100" style={{ left: '80%', right: '0%' }} />
                  <div
                    className={`h-full rounded-full ${calc.binding === 'volume' ? 'bg-red-500' : ratioPct >= 80 ? 'bg-green-500' : 'bg-amber-400'}`}
                    style={{ width: `${Math.min(ratioPct, 100)}%` }}
                  />
                </div>
                <p className="text-xs mt-2 text-gray-600">
                  {calc.binding === 'volume'
                    ? '⚠️ Volume-bound: el carrier cobra el volumétrico (> peso). Agregá piezas pesadas para volver a estar atado por peso, o tus precios fijos subcostean.'
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
                ⚠️ Algunas piezas no tienen peso o dimensiones cargadas — el cálculo las subestima. Revisá las marcadas abajo.
              </p>
            )}
          </div>

          {/* Desglose de costo */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Costo del envío (landed)</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Costo de producto (India)" value={usd(calc.productCostUsd)} />
              <Row label={`Aéreo India→USA · ${calc.airInr.toLocaleString('es-VE')} INR`} value={usd(calc.airUsd)} />
              <Row label="Marítimo USA→VEN (volumen)" value={usd(calc.maritimeUsd)} />
              <Row label="Seguro" value={usd(calc.insuranceUsd)} />
              <Row label="Processing" value={usd(calc.processingUsd)} />
              <div className="flex justify-between pt-3 mt-2 border-t-2 border-gray-200">
                <dt className="font-bold text-gray-900">Costo total landed</dt>
                <dd className="font-bold text-xl font-mono text-blue-700">{usd(calc.landedUsd)}</dd>
              </div>
              {saleTotal > 0 && (
                <>
                  <Row label="Venta (suma de presupuestos)" value={usd(saleTotal)} />
                  <div className="flex justify-between">
                    <dt className="font-semibold text-gray-700">Margen bruto</dt>
                    <dd className={`font-semibold font-mono ${saleTotal - calc.landedUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {usd(saleTotal - calc.landedUsd)}
                      {' '}
                      <span className="text-xs text-gray-400">
                        ({((1 - calc.landedUsd / saleTotal) * 100).toFixed(0)}%)
                      </span>
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </div>

          {/* Presupuestos en el envío */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                Presupuestos en el envío ({envio.pedidos.length})
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-6 py-2 font-semibold">Cliente</th>
                  <th className="text-right px-4 py-2 font-semibold">Costo landed</th>
                  <th className="text-right px-4 py-2 font-semibold">Venta</th>
                  <th className="px-4 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {envio.pedidos.map(ped => (
                  <tr key={ped.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3">
                      <Link href={`/presupuestos/${ped.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                        {ped.clientName}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">{ped.items.length} pzas</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-700">{usd(landedByPedido.get(ped.id) ?? 0)}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-700">{usd(saleByPedido.get(ped.id) ?? 0)}</td>
                    <td className="px-4 py-3 text-right">
                      <form action={removePedido.bind(null, envio.id, ped.id)}>
                        <button type="submit" className="text-xs text-red-600 hover:text-red-800">Quitar</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Desglose por pieza */}
          <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
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
                      {(l.missingWeight || l.missingDims) && (
                        <span className="ml-2 text-xs text-amber-600">
                          {l.missingWeight ? 'sin peso' : ''}{l.missingWeight && l.missingDims ? ' · ' : ''}{l.missingDims ? 'sin dim.' : ''}
                        </span>
                      )}
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

          {/* Lista de compra — qué comprar en India, consolidado por SKU */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                Lista de compra ({buyList.length} {buyList.length === 1 ? 'ítem' : 'ítems'} · {buyUnits} u.)
              </h2>
              <span className="text-xs text-gray-400">Consolidado por código Bajaj</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-6 py-2 font-semibold">Código</th>
                  <th className="text-left px-3 py-2 font-semibold">Pieza</th>
                  <th className="text-right px-3 py-2 font-semibold">Cant.</th>
                  <th className="text-right px-3 py-2 font-semibold">Unit. INR</th>
                  <th className="text-right px-6 py-2 font-semibold">Total INR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {buyList.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-2.5 font-mono text-xs text-gray-500">{r.sku ?? '—'}</td>
                    <td className="px-3 py-2.5 text-gray-900">
                      {r.name}
                      {r.missingPrice && (
                        <span className="ml-2 text-xs text-amber-600">sin precio</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-600">
                      {r.unitInr != null ? r.unitInr.toLocaleString('es-VE') : '—'}
                    </td>
                    <td className="px-6 py-2.5 text-right font-mono font-semibold text-gray-900">
                      {r.totalInr > 0 ? r.totalInr.toLocaleString('es-VE') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-6 py-3 font-bold text-gray-900" colSpan={2}>Total a comprar</td>
                  <td className="px-3 py-3 text-right font-mono font-semibold text-gray-700">{buyUnits}</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-6 py-3 text-right">
                    <span className="font-bold font-mono text-blue-700">{buyTotalInr.toLocaleString('es-VE')} INR</span>
                    <span className="block text-xs text-gray-400 font-mono">≈ {usd(buyTotalUsd)}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {/* Agregar presupuestos */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Agregar presupuesto al envío</h2>
        </div>
        {sinAsignar.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">
            No hay presupuestos sin asignar. <Link href="/presupuestos/new" className="text-blue-600 hover:underline">Creá uno</Link>.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {sinAsignar.map(ped => (
              <div key={ped.id} className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
                <div>
                  <span className="text-sm font-medium text-gray-900">{ped.clientName}</span>
                  <span className="ml-2 text-xs text-gray-400">
                    #{ped.id} · {ped.items.length} pzas · {ped.status}
                  </span>
                </div>
                <form action={assignPedido.bind(null, envio.id, ped.id)}>
                  <button type="submit" className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                    + Agregar
                  </button>
                </form>
              </div>
            ))}
          </div>
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
