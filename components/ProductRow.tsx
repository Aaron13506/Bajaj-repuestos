'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import QuickEditProduct, { type QuickEditValues } from '@/components/QuickEditProduct'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { deleteProduct } from '@/app/(pages)/products/actions'

export interface ComponentData extends QuickEditValues {
  quantity: number
  groupName: string
}

export interface ProductRowData extends QuickEditValues {
  isAssembly: boolean
  componentsCount: number
  components?: ComponentData[]
}

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return '—'
  return `$${n.toFixed(decimals)}`
}

/** Celdas de costo compartidas por la fila principal y las sub-filas de componentes. */
function CostCells({ d, cfg }: { d: QuickEditValues; cfg: ConfigMap }) {
  const b = calcLanded({
    priceInr:    d.priceInr,
    weightGrams: d.weightGrams,
    dimL:        d.dimL,
    dimA:        d.dimA,
    dimH:        d.dimH,
    margin:      d.margin,
  }, cfg)
  return (
    <>
      <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100 text-xs">
        {d.priceInr ? `₹${d.priceInr}` : '—'}
      </td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.productCostUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.shoppreShippingUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.insuranceUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.maritimeUsd) : '—'}</td>
      <td className="px-4 py-3 text-right font-semibold text-gray-900 border-l border-gray-200">{b ? fmt(b.landedCostUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100">
        {d.margin != null ? `${+(d.margin * 100).toFixed(2)}%` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-medium text-gray-900">
        {b?.priceUsd != null ? fmt(b.priceUsd) : fmt(d.price)}
      </td>
      <td className="px-4 py-3 text-right text-gray-700">
        {b?.priceBsd != null ? `Bs.${b.priceBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}` : '—'}
      </td>
    </>
  )
}

export default function ProductRow({ product, cfg }: { product: ProductRowData; cfg: ConfigMap }) {
  // Override optimista: al guardar mostramos los valores nuevos al instante,
  // sin esperar el round-trip a la DB remota. Se limpia cuando llegan props
  // frescas del server (router.refresh), que son la fuente autoritativa.
  const [optimistic, setOptimistic] = useState<QuickEditValues | null>(null)

  // Cada refresh del server crea un product nuevo → descartamos el optimista
  // y volvemos a confiar en los datos reales.
  useEffect(() => { setOptimistic(null) }, [product])

  const [expanded, setExpanded] = useState(false)

  const d = optimistic ? { ...product, ...optimistic } : product
  const components = product.components ?? []
  const canExpand = product.isAssembly && components.length > 0

  return (
    <>
      <tr className={`hover:bg-gray-50 transition-colors ${optimistic ? 'opacity-60' : ''}`}>
        <td className="px-4 py-3 font-mono text-xs text-gray-500">{d.bajajCode ?? '—'}</td>
        <td className="px-4 py-3 font-medium text-gray-900 max-w-[180px] truncate">
          <span className="flex items-center gap-1.5">
            {canExpand && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                title={expanded ? 'Ocultar piezas' : 'Ver piezas'}
                className="shrink-0 text-gray-400 hover:text-gray-700 transition-transform w-4"
              >
                <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
              </button>
            )}
            <Link href={`/products/${d.id}`} className="hover:text-blue-600 transition-colors truncate">
              {d.nameEs}
            </Link>
            {product.isAssembly && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                Ensamble{product.componentsCount > 0 ? ` · ${product.componentsCount}` : ''}
              </span>
            )}
          </span>
          {d.nameEn && (
            <span className="block text-xs font-normal text-gray-400 truncate">{d.nameEn}</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 max-w-[120px] truncate">{d.compatibleModels ?? '—'}</td>
        <td className="px-4 py-3 text-right text-gray-500 text-xs">{d.weightGrams ?? '—'}</td>

        <CostCells d={d} cfg={cfg} />

        <td className="px-4 py-3 text-right border-l border-gray-100">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            d.stock === 0 ? 'bg-red-100 text-red-700'
              : d.stock < 5 ? 'bg-yellow-100 text-yellow-700'
              : 'bg-green-100 text-green-700'
          }`}>
            {d.stock}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-3">
            <QuickEditProduct
              cfg={cfg}
              product={{
                id: product.id,
                nameEs: product.nameEs,
                nameEn: product.nameEn,
                bajajCode: product.bajajCode,
                compatibleModels: product.compatibleModels,
                priceInr: product.priceInr,
                weightGrams: product.weightGrams,
                dimL: product.dimL,
                dimA: product.dimA,
                dimH: product.dimH,
                margin: product.margin,
                price: product.price,
                priceLocked: product.priceLocked,
                stock: product.stock,
              }}
              onOptimistic={setOptimistic}
            />
            <DeleteButton action={deleteProduct.bind(null, product.id)} confirmMessage={`¿Eliminar "${product.nameEs}"?`} />
          </div>
        </td>
      </tr>

      {canExpand && expanded && components.map((c) => (
        <tr key={c.id} className="bg-gray-50/60 text-xs">
          <td className="pl-6 pr-4 py-2 font-mono text-[11px] text-gray-400">{c.bajajCode ?? '—'}</td>
          <td className="px-4 py-2 text-gray-700 max-w-[180px] truncate">
            <span className="flex items-center gap-1.5">
              <span className="text-gray-300">└</span>
              <Link href={`/products/${c.id}`} className="hover:text-blue-600 transition-colors truncate">
                {c.nameEs}
              </Link>
              {c.quantity > 1 && <span className="shrink-0 text-gray-400">×{c.quantity}</span>}
              {c.groupName && (
                <span className="shrink-0 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{c.groupName}</span>
              )}
            </span>
          </td>
          <td className="px-4 py-2 text-gray-400 max-w-[120px] truncate">{c.compatibleModels ?? '—'}</td>
          <td className="px-4 py-2 text-right text-gray-400">{c.weightGrams ?? '—'}</td>

          <CostCells d={c} cfg={cfg} />

          <td className="px-4 py-2 text-right border-l border-gray-100">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
              c.stock === 0 ? 'bg-red-100 text-red-700'
                : c.stock < 5 ? 'bg-yellow-100 text-yellow-700'
                : 'bg-green-100 text-green-700'
            }`}>
              {c.stock}
            </span>
          </td>
          <td className="px-4 py-2 text-right">
            <Link href={`/products/${c.id}`} className="text-blue-600 hover:underline text-xs">Ver</Link>
          </td>
        </tr>
      ))}
    </>
  )
}
