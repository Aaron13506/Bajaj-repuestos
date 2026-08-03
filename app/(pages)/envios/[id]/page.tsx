import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import EnvioItemsTable, { type EnvioItemRow } from '@/components/EnvioItemsTable'
import PendingButton from '@/components/PendingButton'
import PendientesCompraButton, {
  type PendienteGrupo,
  type PendienteRow,
} from '@/components/PendientesCompraButton'
import { limpiarNombre } from '@/lib/utils'
import { calcEnvio, type EnvioItemInput, type ConfigMap } from '@/lib/calc'
import { makeProductLookup, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import {
  assignPedido,
  assignAllConfirmados,
  removePedido,
  deleteEnvio,
  saveEstimate,
  saveInboundChina,
  saveItemChanges,
} from '../actions'

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`
const fecha = (d: Date) => new Date(d).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })

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

  const [envio, cfgRows, sinAsignar, allProducts, supplierPrices, suppliers] = await Promise.all([
    db.envio.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: true, pedido: true, supplier: true },
          orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    db.config.findMany(),
    db.pedidoItem.findMany({
      where: { envioId: null },
      include: { product: { select: { nameEs: true } }, pedido: true },
      orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
    }),
    db.product.findMany({
      select: { id: true, nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true },
    }),
    db.supplierPrice.findMany({ select: { productId: true, supplierId: true, priceUsd: true, isLanded: true } }),
    db.supplier.findMany({ select: { id: true, name: true, origen: true }, orderBy: { name: 'asc' } }),
  ])

  if (!envio) notFound()

  const cfg = cfgRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})

  // Lookup para resolver piezas de conjuntos a su producto real (por bajajCode).
  const lookup = makeProductLookup(allProducts as ProductCost[])

  // Precio del proveedor por (proveedor, producto): cuando la línea se compró a un
  // proveedor puntual, ese USD es el costo real y le gana al priceInr del catálogo.
  const precioProveedor = new Map(
    supplierPrices.map(sp => [`${sp.supplierId}:${sp.productId}`, parseFloat(sp.priceUsd.toString())])
  )

  // Aplanar todas las piezas del envío. Los conjuntos se expanden a sus piezas reales
  // para costearlos por las piezas que llevan, no por el ensamble entero. Cada pieza
  // hereda el origen y el isLanded de SU línea de pedido: eso define por qué tramo
  // entra y si viaja o no en esta caja.
  const allPieces = envio.items.flatMap(it =>
    expandCostPieces(
      it.product as ProductCost,
      it.quantity,
      it.bundleItems as BundlePiece[] | null,
      lookup,
    ).map(piece => ({
      ...piece,
      itemId: it.id,
      pedidoId: it.pedidoId,
      // productId de la LÍNEA (el ensamble, si es un conjunto). El de la pieza suelta
      // vive en piece.productId y solo se usa para resolver el precio de proveedor.
      productId: it.productId,
      origen: (it.origen === 'china' ? 'china' : 'india') as 'india' | 'china',
      isLanded: it.isLanded,
      shippingStatus: it.shippingStatus,
      supplierId: it.supplierId,
      supplierName: it.supplier?.name ?? null,
      priceUsd: it.supplierId != null && piece.productId != null
        ? precioProveedor.get(`${it.supplierId}:${piece.productId}`) ?? null
        : null,
    }))
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
    priceUsd: p.priceUsd,
    quantity: p.quantity,
    origen: p.origen,
    isLanded: p.isLanded,
  }))

  const inboundChinaUsd = envio.inboundChinaUsd != null ? parseFloat(envio.inboundChinaUsd.toString()) : null
  const calc = calcEnvio(items, cfg, { inboundChinaUsd })

  // Lista de compra: consolida las piezas por SKU (o nombre si no tiene SKU) sumando
  // cantidades, para saber exactamente qué y cuánto comprar. Separada por origen,
  // porque son dos órdenes de compra distintas a dos proveedores distintos.
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  interface BuyRow {
    sku: string | null
    name: string
    qty: number
    unitInr: number | null
    totalInr: number
    missingPrice: boolean
  }
  const buildBuyList = (origen: 'india' | 'china') => {
    const buyMap = new Map<string, BuyRow>()
    for (const p of allPieces) {
      if (p.origen !== origen) continue
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
    return Array.from(buyMap.values()).sort((a, b) => b.totalInr - a.totalInr)
  }
  const buyIndia = buildBuyList('india')
  const buyChina = buildBuyList('china')
  const buyTotalInr = buyIndia.reduce((s, r) => s + r.totalInr, 0)
  const buyTotalUsd = buyTotalInr / inrUsd
  const buyUnits = buyIndia.reduce((s, r) => s + r.qty, 0)

  // Lo que TODAVÍA falta comprar: las mismas piezas, pero solo de las líneas que siguen
  // en 'pendiente'. La lista de compra de arriba es el envío entero (incluye lo ya
  // comprado); esta es la que se lleva al proveedor. Se parte por proveedor porque cada
  // uno es una orden distinta, y dentro de cada uno se consolida por SKU: si tres
  // presupuestos piden la misma pastilla, se pide una sola vez.
  const pendMap = new Map<string, PendienteGrupo>()
  for (const p of allPieces) {
    if (p.shippingStatus !== 'pendiente') continue
    const gk = p.supplierId != null ? `s${p.supplierId}` : `base-${p.origen}`
    let grupo = pendMap.get(gk)
    if (!grupo) {
      grupo = {
        key: gk,
        proveedor: p.supplierName ?? '99rpm (base)',
        origen: p.origen,
        rows: [],
      }
      pendMap.set(gk, grupo)
    }
    const key = p.sku ?? p.name
    let row = grupo.rows.find(r => (r.sku ?? r.name) === key)
    if (!row) {
      row = {
        sku: p.sku,
        name: limpiarNombre(p.name),
        qty: 0,
        unitInr: p.priceInr,
        unitUsd: p.priceUsd,
        isLanded: p.isLanded,
      }
      grupo.rows.push(row)
    }
    row.qty += p.quantity
    if (row.unitInr == null) row.unitInr = p.priceInr
    if (row.unitUsd == null) row.unitUsd = p.priceUsd
  }
  const costoFila = (r: PendienteRow) =>
    r.unitUsd != null ? r.unitUsd * r.qty : (r.unitInr ?? 0) * r.qty / inrUsd
  // India primero (es la orden grande y la que manda el peso cobrable), y dentro, el
  // proveedor más caro arriba.
  const pendientes = Array.from(pendMap.values())
    .map(g => ({ ...g, rows: [...g.rows].sort((a, b) => costoFila(b) - costoFila(a)) }))
    .sort((a, b) => {
      if (a.origen !== b.origen) return a.origen === 'india' ? -1 : 1
      return b.rows.reduce((s, r) => s + costoFila(r), 0) - a.rows.reduce((s, r) => s + costoFila(r), 0)
    })

  // Venta y landed, agregados por línea de pedido para la tabla de arriba.
  const saleByItem = new Map<number, number>()
  for (const it of envio.items) {
    saleByItem.set(it.id, parseFloat(it.salePrice.toString()) * it.quantity)
  }
  const saleTotal = Array.from(saleByItem.values()).reduce((s, v) => s + v, 0)

  const landedByItem = new Map<number, number>()
  for (let i = 0; i < calc.lines.length; i++) {
    const itemId = allPieces[i].itemId
    landedByItem.set(itemId, (landedByItem.get(itemId) ?? 0) + calc.lines[i].landedUsd)
  }

  // Datos serializables para la tabla (client component). Se le pasa todo resuelto para
  // que pueda pintar los cambios sin volver al servidor.
  const itemRows: EnvioItemRow[] = envio.items.map(it => ({
    id: it.id,
    pedidoId: it.pedidoId,
    clientName: it.pedido.clientName,
    productId: it.productId,
    nombre: it.product.nameEs,
    bajajCode: it.product.bajajCode,
    quantity: it.quantity,
    piezas: (it.bundleItems as BundlePiece[] | null) ?? [],
    landed: landedByItem.get(it.id) ?? 0,
    venta: saleByItem.get(it.id) ?? 0,
    shippingStatus: it.shippingStatus,
    supplierId: it.supplierId,
    shippingStatusAt: it.shippingStatusAt?.toISOString() ?? null,
  }))

  // Pares (proveedor, producto) que cotizan puestos en Venezuela: con esto la tabla deduce
  // la ruta al vuelo cuando cambiás de proveedor, sin consultar nada.
  const landedPairs = supplierPrices
    .filter(sp => sp.isLanded)
    .map(sp => `${sp.supplierId}:${sp.productId}`)

  // Lo confirmado (status='pedido') es lo que hay que comprar sí o sí; los
  // presupuestos sin aprobar todavía pueden caerse, así que se separan y nunca
  // entran al agregado masivo.
  const agruparSueltos = (pred: (p: (typeof sinAsignar)[number]) => boolean) => {
    const m = new Map<number, typeof sinAsignar>()
    for (const it of sinAsignar) {
      if (!pred(it)) continue
      const arr = m.get(it.pedidoId) ?? []
      arr.push(it)
      m.set(it.pedidoId, arr)
    }
    return Array.from(m.values())
  }
  const confirmadosSinAsignar = agruparSueltos(it => it.pedido.status === 'pedido')
  const presupuestosSinAsignar = agruparSueltos(it => it.pedido.status === 'presupuesto')
  const confirmadosPropios = confirmadosSinAsignar.filter(g => g[0].pedido.tipo === 'propio').length

  const anyMissing = calc.lines.some(l => l.missingWeight || l.missingDims)
  const tierHint = airTierHint(calc.air.chargeableKg)
  const ratioPct = calc.air.ratioVW != null ? calc.air.ratioVW * 100 : null
  const shippingEst = calc.airUsd + calc.maritimeUsd
  const fmtBound =
    calc.air.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  const hayChina = calc.china.items > 0
  const faltaCostoChina = hayChina && inboundChinaUsd == null

  return (
    <div className="max-w-screen-2xl">
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
            confirmMessage={`¿Eliminar el envío "${envio.nombre ?? `#${envio.id}`}"? Los ítems quedarán libres.`}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 mb-8">
          <p className="text-lg">Este envío está vacío</p>
          <p className="text-sm mt-1">Agregá ítems abajo para calcular el peso cobrable y el costo.</p>
        </div>
      ) : (
        <>
          {/* Los paneles de costo son angostos por naturaleza (listas de pares
              etiqueta/valor): en pantalla ancha van lado a lado en vez de apilarse y
              empujar la tabla de ítems fuera de la vista. */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4 items-start">
          {/* Tramo India → USA (ShipGlobal): el único que cotiza por tabla escalón */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                🇮🇳 Tramo India → USA · peso cobrable
              </h2>
              {calc.air.items > 0 && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
              )}
            </div>
            {calc.air.items === 0 ? (
              <p className="text-sm text-gray-400">No hay piezas de India en este envío.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Peso real (ΣW)</p>
                    <p className={`text-xl font-bold font-mono ${calc.air.binding === 'weight' ? 'text-green-700' : 'text-gray-900'}`}>{kg(calc.air.realKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Volumétrico (ΣV)</p>
                    <p className={`text-xl font-bold font-mono ${calc.air.binding === 'volume' ? 'text-red-700' : 'text-gray-900'}`}>{kg(calc.air.volKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
                    <p className="text-xl font-bold font-mono text-blue-700">{kg(calc.air.chargeableKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Aéreo / kg</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.air.costPerKgUsd)}</p>
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
                        className={`h-full rounded-full ${calc.air.binding === 'volume' ? 'bg-red-500' : ratioPct >= 80 ? 'bg-green-500' : 'bg-amber-400'}`}
                        style={{ width: `${Math.min(ratioPct, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs mt-2 text-gray-600">
                      {calc.air.binding === 'volume'
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
              </>
            )}

            {anyMissing && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                ⚠️ Algunas piezas no tienen peso o dimensiones cargadas — el cálculo las subestima. Revisá las marcadas abajo.
              </p>
            )}
          </div>

          {/* Tramo China → USA: sin tabla, se carga el costo real facturado */}
          {hayChina && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
                🇨🇳 Tramo China → USA · costo real
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Piezas</p>
                  <p className="text-xl font-bold font-mono text-gray-900">{calc.china.items}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Peso real</p>
                  <p className="text-xl font-bold font-mono text-gray-900">{kg(calc.china.realKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Volumétrico</p>
                  <p className="text-xl font-bold font-mono text-gray-900">{kg(calc.china.volKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Costo / kg</p>
                  <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.china.costPerKgUsd)}</p>
                </div>
              </div>
              <form action={saveInboundChina.bind(null, envio.id)} className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Flete China → USA (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="inboundChinaUsd"
                    defaultValue={inboundChinaUsd ?? ''}
                    placeholder="0.00"
                    className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Guardar
                </button>
                {faltaCostoChina && (
                  <span className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                    ⚠️ Sin este dato las piezas de China viajan gratis en el cálculo y el envío queda subcosteado.
                  </span>
                )}
              </form>
            </div>
          )}

          {/* Desglose de costo */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Costo del envío (landed)</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Costo de producto" value={usd(calc.productCostUsd)} />
              <Row label={`Aéreo India→USA · ${calc.air.chargeableKg.toFixed(1)} kg cobrables`} value={usd(calc.air.costUsd)} />
              {hayChina && <Row label="Flete China→USA (real)" value={usd(calc.china.costUsd)} />}
              <Row label="Marítimo USA→VEN (volumen)" value={usd(calc.maritimeUsd)} />
              <Row label="Seguro" value={usd(calc.insuranceUsd)} />
              <Row label="Processing" value={usd(calc.processingUsd)} />
              {calc.landedDirectUsd > 0 && (
                <Row label="Compras puestas en Venezuela (no viajan)" value={usd(calc.landedDirectUsd)} />
              )}
              <div className="flex justify-between pt-3 mt-2 border-t-2 border-gray-200">
                <dt className="font-bold text-gray-900">Costo total landed</dt>
                <dd className="font-bold text-xl font-mono text-blue-700">{usd(calc.landedUsd)}</dd>
              </div>
              {saleTotal > 0 && (
                <>
                  <Row label="Venta (suma de los ítems)" value={usd(saleTotal)} />
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
          </div>

          {/* Ítems del envío: los cambios se pintan al instante y se guardan por detrás
              (la base es remota, esperar cada round-trip mata el uso). */}
          <EnvioItemsTable
            envioId={envio.id}
            items={itemRows}
            suppliers={suppliers}
            landedPairs={landedPairs}
            guardar={saveItemChanges}
            quitar={removePedido}
          />

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
                  <th className="text-right px-3 py-2 font-semibold">A USA</th>
                  <th className="text-right px-3 py-2 font-semibold">Marít.</th>
                  <th className="text-right px-4 py-2 font-semibold">Landed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {calc.lines.map((l, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-2.5">
                      <span className="text-xs mr-1">{l.isLanded ? '📍' : l.origen === 'china' ? '🇨🇳' : '🇮🇳'}</span>
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

          {/* Lo pendiente de comprar, listo para copiar o bajar en CSV */}
          <PendientesCompraButton
            envio={envio.nombre ?? `Envío #${envio.id}`}
            grupos={pendientes}
            inrUsd={inrUsd}
          />

          {/* Lista de compra — separada por origen: son dos órdenes distintas */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                🇮🇳 Lista de compra India ({buyIndia.length} {buyIndia.length === 1 ? 'ítem' : 'ítems'} · {buyUnits} u.)
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
                {buyIndia.map((r, i) => (
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

          {buyChina.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
              <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                  🇨🇳 Lista de compra China ({buyChina.length} {buyChina.length === 1 ? 'ítem' : 'ítems'})
                </h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-6 py-2 font-semibold">Código</th>
                    <th className="text-left px-3 py-2 font-semibold">Pieza</th>
                    <th className="text-right px-6 py-2 font-semibold">Cant.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {buyChina.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-2.5 font-mono text-xs text-gray-500">{r.sku ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-900">{r.name}</td>
                      <td className="px-6 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Pedidos confirmados con ítems sin asignar */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Pedidos confirmados con ítems sueltos ({confirmadosSinAsignar.length})
          </h2>
          {confirmadosSinAsignar.length > 0 && (
            <form
              action={assignAllConfirmados.bind(null, envio.id)}
              className="flex items-center gap-3"
            >
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" name="incluirPropio" defaultChecked className="rounded border-gray-300" />
                Incluir stock propio ({confirmadosPropios})
              </label>
              <PendingButton
                pendingLabel="Agregando…"
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors"
              >
                + Agregar todos los confirmados
              </PendingButton>
            </form>
          )}
        </div>
        {confirmadosSinAsignar.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">
            No hay pedidos confirmados con ítems sin asignar.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {confirmadosSinAsignar.map(its => (
              <SueltoRow key={its[0].pedidoId} envioId={envio.id} items={its} />
            ))}
          </div>
        )}
      </div>

      {/* Presupuestos sin aprobar (informativo, no entran al agregado masivo) */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Presupuestos sin aprobar ({presupuestosSinAsignar.length})
          </h2>
        </div>
        {presupuestosSinAsignar.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">
            No hay presupuestos pendientes. <Link href="/presupuestos/new" className="text-blue-600 hover:underline">Creá uno</Link>.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {presupuestosSinAsignar.map(its => (
              <SueltoRow key={its[0].pedidoId} envioId={envio.id} items={its} sinAprobar />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SueltoRow({
  envioId,
  items,
  sinAprobar,
}: {
  envioId: number
  items: { id: number; pedidoId: number; pedido: { clientName: string; tipo: string } }[]
  sinAprobar?: boolean
}) {
  const ped = items[0].pedido
  return (
    <div className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
      <div>
        <span className="text-sm font-medium text-gray-900">{ped.clientName}</span>
        <span className="ml-2 text-xs text-gray-400">
          #{items[0].pedidoId} · {items.length} {items.length === 1 ? 'ítem suelto' : 'ítems sueltos'}
        </span>
        {ped.tipo === 'propio' && (
          <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
            Stock propio
          </span>
        )}
        {sinAprobar && (
          <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
            Sin aprobar
          </span>
        )}
      </div>
      <form action={assignPedido.bind(null, envioId, items[0].pedidoId)}>
        <PendingButton pendingLabel="Agregando…" className="text-sm text-blue-600 hover:text-blue-800 font-medium">
          + Agregar
        </PendingButton>
      </form>
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
