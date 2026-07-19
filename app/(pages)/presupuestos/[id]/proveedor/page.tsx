import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import PrintButton from '@/components/PrintButton'
import { type BundlePiece } from '@/lib/bundle'

interface Line {
  sku: string
  name: string
  quantity: number
}

export default async function ProveedorPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const pedido = await db.pedido.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: { select: { nameEs: true, bajajCode: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
  })

  if (!pedido) notFound()

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
      for (const p of bundlePieces) {
        addLine(p.bajajCode, p.nameEs, p.quantity * item.quantity)
      }
    } else {
      addLine(item.product.bajajCode, item.product.nameEs, item.quantity)
    }
  }

  let lines = Array.from(linesMap.values())

  // Prefer English names (the supplier's language) by matching SKU against the catalog.
  const skus = lines.map(l => l.sku).filter(sku => sku !== '—')
  if (skus.length > 0) {
    const products = await db.product.findMany({
      where: { bajajCode: { in: skus } },
      select: { bajajCode: true, nameEn: true },
    })
    const nameEnBySku = new Map(
      products.filter(p => p.nameEn).map(p => [p.bajajCode as string, p.nameEn as string])
    )
    lines = lines.map(l => ({ ...l, name: nameEnBySku.get(l.sku) ?? l.name }))
  }

  lines.sort((a, b) => a.sku.localeCompare(b.sku))
  const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0)

  return (
    <div className="max-w-2xl">
      {/* Screen-only header */}
      <div className="flex items-start justify-between gap-4 mb-6 print:hidden">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href={`/presupuestos/${id}`} className="text-gray-400 hover:text-gray-600 text-sm">
              {pedido.clientName}
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Para proveedor</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Orden para proveedor</h1>
        </div>
        <PrintButton />
      </div>

      {/* Print-only letterhead — no internal order number or date, just what's being requested */}
      <div className="hidden print:block mb-5">
        <h1 className="text-xl font-bold text-gray-900">Bajaj Repuestos</h1>
        <hr className="mt-3 border-gray-300" />
      </div>

      {/* Items table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4 print:border-0 print:shadow-none print:rounded-none">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 print:bg-transparent">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-32">
                SKU
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Part
              </th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">
                Qty
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {lines.map(line => (
              <tr key={line.sku + line.name} className="hover:bg-gray-50 print:hover:bg-transparent break-inside-avoid">
                <td className="px-4 py-3 text-sm font-mono text-gray-700 align-top">{line.sku}</td>
                <td className="px-4 py-3 text-sm text-gray-900 align-top">{line.name}</td>
                <td className="px-4 py-3 text-center text-sm font-semibold text-gray-900 align-top">
                  {line.quantity}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Total */}
      <div className="flex justify-end mb-4 break-inside-avoid">
        <div className="flex justify-between items-baseline w-48 border-t-2 border-gray-200 pt-3">
          <span className="font-bold text-gray-900">Total qty</span>
          <span className="font-bold text-xl font-mono text-gray-900">{totalQty}</span>
        </div>
      </div>
    </div>
  )
}
