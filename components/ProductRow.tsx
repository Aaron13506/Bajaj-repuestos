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

/**
 * Celdas de costo compartidas por la fila principal y las sub-filas de componentes, y
 * reusadas tal cual en la ficha del ensamble (Componentes) para el mismo desglose.
 * priceInr/price son SIEMPRE por unidad; con `quantity` (solo en sub-filas de un ensamble
 * puntual) se agrega el total de esa línea en chico, para no confundir unidad con total.
 */
export function CostCells({ d, cfg, quantity }: { d: QuickEditValues; cfg: ConfigMap; quantity?: number }) {
  const forCalc = {
    priceInr:      d.priceInr,
    priceUsd:      d.priceUsd,
    priceIsLanded: d.priceIsLanded,
    weightGrams:   d.weightGrams,
    dimL:          d.dimL,
    dimA:          d.dimA,
    dimH:          d.dimH,
    margin:        d.margin,
  }
  const b = calcLanded(forCalc, cfg)
  // Mismo cálculo por mar directo desde India. Es una columna comparativa: el precio que se
  // guarda y se cotiza sigue saliendo del aéreo (b), no de acá.
  const m = calcLanded(forCalc, cfg, 'maritimo')

  // Flete de hoy = lo que se paga para mover la pieza (Shoppre aéreo + marítimo Miami→CCS).
  // Flete por mar = un solo tramo. Se comparan estos dos, y los landed que resultan.
  const fleteHoy = b ? b.shoppreShippingUsd + b.maritimeUsd : null
  const fleteMar = m ? m.maritimeUsd : null
  const deltaPct = b && m && b.landedCostUsd > 0
    ? ((m.landedCostUsd - b.landedCostUsd) / b.landedCostUsd) * 100
    : null

  const multi = (quantity ?? 1) > 1
  const saleUsd = b?.priceUsd ?? parseFloat(d.price.toString())
  const hasSupplierOverride = d.priceUsd != null
  return (
    <>
      <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100 text-xs">
        {hasSupplierOverride ? (
          <>
            ${d.priceUsd!.toFixed(2)}
            {multi && (
              <span className="block text-gray-400">total: ${(d.priceUsd! * quantity!).toFixed(2)}</span>
            )}
          </>
        ) : d.priceInr ? (
          <>
            ₹{d.priceInr}
            {multi && (
              <span className="block text-gray-400">total: ₹{d.priceInr * quantity!}</span>
            )}
          </>
        ) : '—'}
      </td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.productCostUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.shoppreShippingUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.insuranceUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.maritimeUsd) : '—'}</td>
      <td className="px-4 py-3 text-right font-medium text-gray-700">{fleteHoy != null ? fmt(fleteHoy) : '—'}</td>
      <td className="px-4 py-3 text-right font-semibold text-gray-900 border-l border-gray-200">{b ? fmt(b.landedCostUsd) : '—'}</td>

      {/* ── Escenario marítimo directo: flete y landed que resultarían por mar ── */}
      <td className="px-4 py-3 text-right text-sky-800 bg-sky-50/50 border-l-2 border-sky-200">
        {fleteMar != null ? fmt(fleteMar) : <span className="text-sky-300" title="Faltan dimensiones">—</span>}
      </td>
      <td className="px-4 py-3 text-right font-semibold text-sky-900 bg-sky-50/50">
        {m ? fmt(m.landedCostUsd) : <span className="text-sky-300" title="Faltan dimensiones">—</span>}
      </td>
      <td className="px-4 py-3 text-right font-medium text-sky-900 bg-sky-50/50">
        {m?.priceUsd != null ? (
          <>
            {fmt(m.priceUsd)}
            {m.priceBsd != null && (
              <span className="block text-[11px] font-normal text-sky-600">
                Bs.{m.priceBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}
              </span>
            )}
            {multi && (
              <span className="block text-[11px] font-normal text-sky-400">total: {fmt(m.priceUsd * quantity!)}</span>
            )}
          </>
        ) : (
          <span className="text-sky-300" title={m ? 'Sin margen definido' : 'Faltan dimensiones'}>—</span>
        )}
      </td>
      {/* El Δ es el mismo para landed y para venta: el precio sale de aplicar el mismo
          margen sobre el landed, así que la proporción entre escenarios no cambia. */}
      <td className={`px-4 py-3 text-right font-semibold bg-sky-50/50 border-r-2 border-sky-200 ${
        deltaPct == null ? 'text-sky-300' : deltaPct <= 0 ? 'text-green-700' : 'text-red-600'
      }`}>
        {deltaPct == null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}%`}
      </td>

      <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100">
        {d.margin != null ? `${+(d.margin * 100).toFixed(2)}%` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-medium text-gray-900">
        {fmt(saleUsd)}
        {multi && (
          <span className="block text-[11px] font-normal text-gray-400">total: {fmt(saleUsd * quantity!)}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right text-gray-700">
        {b?.priceBsd != null ? `Bs.${b.priceBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}` : '—'}
      </td>
    </>
  )
}

export default function ProductRow({ product, cfg, activeSupplierId }: { product: ProductRowData; cfg: ConfigMap; activeSupplierId: number | null }) {
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
              activeSupplierId={activeSupplierId}
              product={{
                id: product.id,
                nameEs: product.nameEs,
                nameEn: product.nameEn,
                bajajCode: product.bajajCode,
                compatibleModels: product.compatibleModels,
                priceInr: product.priceInr,
                priceUsd: product.priceUsd,
                priceIsLanded: product.priceIsLanded,
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
          <td className="px-4 py-2 text-right text-gray-400">
            {c.weightGrams ?? '—'}
            {c.quantity > 1 && c.weightGrams != null && (
              <span className="block text-gray-300">total: {c.weightGrams * c.quantity} g</span>
            )}
          </td>

          <CostCells d={c} cfg={cfg} quantity={c.quantity} />

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
