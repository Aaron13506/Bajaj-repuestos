import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'
import { calcLanded, type ConfigMap } from '@/lib/calc'

interface Line {
  sku: string
  name: string
  quantity: number
}

interface Column {
  id: number | null // null = 99rpm (base)
  name: string
}

export default async function CompararProveedoresPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [pedido, suppliers, configRows] = await Promise.all([
    db.pedido.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: { select: { nameEs: true, bajajCode: true } } },
          orderBy: { id: 'asc' },
        },
      },
    }),
    db.supplier.findMany({ orderBy: { name: 'asc' } }),
    db.config.findMany(),
  ])

  if (!pedido) notFound()

  const cfg = configRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})

  // Misma lógica de aplanado que la página "Para proveedor": suma por SKU tanto las
  // piezas de conjuntos (bundleItems) como las piezas sueltas del presupuesto.
  const linesMap = new Map<string, Line>()
  const addLine = (sku: string | null, name: string, qty: number) => {
    const key = sku ?? `__nosku__${name}`
    const existing = linesMap.get(key)
    if (existing) existing.quantity += qty
    else linesMap.set(key, { sku: sku ?? '—', name, quantity: qty })
  }
  for (const item of pedido.items) {
    const bundlePieces = (item.bundleItems as BundlePiece[] | null) ?? []
    if (bundlePieces.length > 0) {
      for (const p of bundlePieces) addLine(p.bajajCode, p.nameEs, p.quantity * item.quantity)
    } else {
      addLine(item.product.bajajCode, item.product.nameEs, item.quantity)
    }
  }
  const lines = Array.from(linesMap.values()).sort((a, b) => a.sku.localeCompare(b.sku))

  // Costo de origen (₹ base + peso/dims) de cada SKU, para alimentar calcLanded.
  const skus = lines.map(l => l.sku).filter(sku => sku !== '—')
  const products = skus.length > 0
    ? await db.product.findMany({
        where: { bajajCode: { in: skus } },
        select: {
          id: true, bajajCode: true, priceInr: true, weightGrams: true,
          dimL: true, dimA: true, dimH: true,
        },
      })
    : []
  const bySku = new Map(products.filter(p => p.bajajCode).map(p => [p.bajajCode as string, p]))

  // Overrides de precio USD de TODOS los proveedores para estos productos, en una sola
  // consulta — se indexan como `${supplierId}:${productId}` para lookup O(1) por celda.
  const productIds = products.map(p => p.id)
  const supplierPrices = productIds.length > 0
    ? await db.supplierPrice.findMany({ where: { productId: { in: productIds } } })
    : []
  const overrideBySupplierProduct = new Map<string, { priceUsd: number; isLanded: boolean }>()
  for (const sp of supplierPrices) {
    overrideBySupplierProduct.set(`${sp.supplierId}:${sp.productId}`, {
      priceUsd: parseFloat(sp.priceUsd.toString()),
      isLanded: sp.isLanded,
    })
  }

  const columns: Column[] = [
    { id: null, name: '99rpm (base)' },
    ...suppliers.map(s => ({ id: s.id, name: s.name })),
  ]

  // Desglose landed por pieza, SIEMPRE independiente (calcLanded) — nunca se prorratea el
  // flete/marítimo entre las demás líneas del presupuesto: piezas de rubros distintos de
  // este pedido (ej. un silenciador o un lockset) no deben inflar ni diluir el costo de
  // un filtro solo porque comparten la misma cotización. Por (línea, columna), null si
  // falta match de SKU o peso. Devuelve tanto el costo base (producto puesto en USD, sin
  // flete) como el landed (con Shoppre/seguro/marítimo) para poder mostrar los dos.
  function breakdownFor(line: Line, col: Column): { baseUsd: number; landedUsd: number } | null {
    const product = bySku.get(line.sku)
    if (!product) return null
    const override = col.id != null ? overrideBySupplierProduct.get(`${col.id}:${product.id}`) : null
    const breakdown = calcLanded({
      priceInr:      product.priceInr,
      priceUsd:      override?.priceUsd ?? null,
      priceIsLanded: override?.isLanded ?? false,
      weightGrams:   product.weightGrams,
      dimL:          product.dimL,
      dimA:          product.dimA,
      dimH:          product.dimH,
      margin:        null,
    }, cfg)
    if (!breakdown) return null
    return { baseUsd: breakdown.productCostUsd, landedUsd: breakdown.landedCostUsd }
  }

  // Total por columna = suma de (costo unitario × cantidad) de cada línea con match —
  // igual que sumar filas de la tabla, ninguna línea influye en el costo de las demás.
  const totalsByCol = columns.map(col =>
    lines.reduce((sum, line) => {
      const b = breakdownFor(line, col)
      return b != null ? sum + b.landedUsd * line.quantity : sum
    }, 0)
  )
  const baseTotal = totalsByCol[0]

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href={`/presupuestos/${id}`} className="text-gray-400 hover:text-gray-600 text-sm">
              {pedido.clientName}
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Comparar proveedores</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Comparar costo de origen por proveedor</h1>
          <p className="text-sm text-gray-500 mt-1">
            Costo landed de cada pieza (individual, sin mezclar con las demás del presupuesto) según de dónde se
            compre — producto + envío + seguro + marítimo, salvo proveedores marcados como &quot;ya landed&quot; en
            /suppliers. No afecta el precio ya cotizado al cliente — es solo para elegir dónde conviene comprar.
          </p>
        </div>
      </div>

      {suppliers.length === 0 && (
        <div className="mb-4 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg px-4 py-3 text-sm">
          Todavía no cargaste otros proveedores en <Link href="/suppliers" className="underline font-medium">/suppliers</Link> —
          por ahora solo se puede ver el costo base de 99rpm.
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">SKU</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Pieza</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Cant.</th>
              {columns.map(col => (
                <th key={col.id ?? 'base'} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide border-l border-gray-100">
                  {col.name}
                  <span className="block text-[10px] font-normal normal-case text-gray-400">landed · base</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {lines.map(line => {
              const breakdowns = columns.map(col => breakdownFor(line, col))
              const cheapest = breakdowns.reduce<number | null>((min, b) => {
                if (b == null) return min
                return min == null || b.landedUsd < min ? b.landedUsd : min
              }, null)
              return (
                <tr key={line.sku + line.name} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{line.sku}</td>
                  <td className="px-4 py-3 text-gray-900">{line.name}</td>
                  <td className="px-4 py-3 text-center text-gray-700">{line.quantity}</td>
                  {columns.map((col, i) => {
                    const b = breakdowns[i]
                    const isCheapest = b != null && cheapest != null && b.landedUsd === cheapest
                    return (
                      <td
                        key={col.id ?? 'base'}
                        className={`px-4 py-3 text-right border-l border-gray-100 ${
                          isCheapest ? 'bg-green-50 font-semibold text-green-800' : 'text-gray-700'
                        }`}
                      >
                        {b != null ? (
                          <>
                            ${b.landedUsd.toFixed(2)}
                            <span className="block text-[11px] font-normal text-gray-400">
                              ×{line.quantity} = ${(b.landedUsd * line.quantity).toFixed(2)}
                            </span>
                            <span className="block text-[11px] font-normal text-gray-400">
                              base ${b.baseUsd.toFixed(2)}
                            </span>
                          </>
                        ) : '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <td className="px-4 py-3" colSpan={3}>Total</td>
              {columns.map((col, i) => {
                const total = totalsByCol[i]
                const isCheapest = total === Math.min(...totalsByCol.filter(t => t > 0))
                const savings = col.id != null && baseTotal > 0 ? baseTotal - total : null
                return (
                  <td
                    key={col.id ?? 'base'}
                    className={`px-4 py-3 text-right border-l border-gray-100 ${isCheapest ? 'text-green-800' : 'text-gray-900'}`}
                  >
                    ${total.toFixed(2)}
                    {savings != null && savings !== 0 && (
                      <span className={`block text-[11px] font-normal ${savings > 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {savings > 0 ? '−' : '+'}${Math.abs(savings).toFixed(2)} vs 99rpm
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
