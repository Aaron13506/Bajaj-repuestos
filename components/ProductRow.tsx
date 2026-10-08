'use client'

import { useState } from 'react'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import QuickEditProduct, { type QuickEditValues } from '@/components/QuickEditProduct'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import IndicadorMedido from '@/components/IndicadorMedido'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { formatModels } from '@/lib/modelo'
import { costHeaders } from '@/lib/cost-columns'
import { deleteProduct } from '@/app/(pages)/products/actions'

// Los encabezados de las columnas de costo viven en lib/cost-columns: este módulo es
// 'use client' y las tablas que los usan se arman en el server, que no puede llamar a una
// función exportada desde un módulo cliente. Las CELDAS que los llenan sí viven acá.

/** Un ensamble al que pertenece la pieza (uno por ensamble, aunque esté en varios grupos). */
export interface EnsambleDePieza {
  id: number
  nameEs: string
  models: string[]
  grupos: string[]
  quantity: number
}

export interface ProductRowData extends QuickEditValues {
  assemblies: EnsambleDePieza[]
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
export function CostCells({ d, cfg, quantity, maritimo = true }: {
  d: QuickEditValues
  cfg: ConfigMap
  quantity?: number
  /** false = sin el bloque marítimo. Va igual que el `maritimo` de costHeaders. */
  maritimo?: boolean
}) {
  const fisico = {
    weightGrams: d.weightGrams,
    dimL:        d.dimL,
    dimA:        d.dimA,
    dimH:        d.dimH,
    margin:      d.margin,
  }
  // El AÉREO se cotiza siempre contra 99rpm: es el único distribuidor que llega al mínimo
  // de Shoppre, así que el precio de un proveedor alternativo no describe nada por avión.
  // Con precio fijo, el precio ES el escrito: no se recompone desde el margen.
  const precioFijo = d.priceLocked ? Number(d.price) : null
  const forAereo = { ...fisico, priceInr: d.priceInr, priceUsd: null, priceIsLanded: false, precioFijo }
  // El MARÍTIMO sí usa el proveedor elegido: por barco se le compra a quien convenga, y
  // ahí su precio en USD es el costo real de la pieza.
  const forMar = { ...fisico, priceInr: d.priceInr, priceUsd: d.priceUsd, priceIsLanded: d.priceIsLanded }
  // Las DOS rutas, siempre, una al lado de la otra. No hay interruptor que elegir: el
  // aéreo es el que manda en el precio de venta (es por donde salen los pedidos de
  // cliente), y el marítimo está al lado porque es la pregunta que uno se hace al
  // abastecerse — cuánto más barato sale la misma pieza si puede esperar el barco.
  const b = calcLanded(forAereo, cfg, 'aereo')
  const m = calcLanded(forMar, cfg, 'maritimo_cbm')

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

  // Costo de origen: el de 99rpm en ₹ (la base aérea) y, si hay proveedor con precio
  // cargado, el suyo en USD debajo — que es el que manda por barco.
  const costoOrigen = (
    <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100 text-xs">
      {d.priceInr ? (
        <>
          ₹{d.priceInr}
          {multi && <span className="block text-gray-400">total: ₹{d.priceInr * quantity!}</span>}
        </>
      ) : !hasSupplierOverride ? '—' : null}
      {hasSupplierOverride && (
        <span className="block text-sky-700" title="Precio del proveedor elegido — solo aplica por barco">
          🚢 ${d.priceUsd!.toFixed(2)}
          {multi && <span className="block text-sky-400">total: ${(d.priceUsd! * quantity!).toFixed(2)}</span>}
        </span>
      )}
    </td>
  )

  // Margen y precio de venta, que salen del landed del modo activo.
  const cola = (
    <>
      <td className="px-4 py-3 text-right text-gray-500 border-l border-gray-100">
        {d.margin != null ? `${+(d.margin * 100).toFixed(2)}%` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-medium text-gray-900">
        {fmt(saleUsd)}
        {multi && (
          <span className="block text-[11px] font-normal text-gray-400">total: {fmt(saleUsd * quantity!)}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-medium text-gray-900">
        {b?.priceBcv != null ? fmt(b.priceBcv.priceUsdBcv) : '—'}
      </td>
    </>
  )

  return (
    <>
      {costoOrigen}
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.productCostUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.shoppreShippingUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.insuranceUsd) : '—'}</td>
      <td className="px-4 py-3 text-right text-gray-600">{b ? fmt(b.maritimeUsd) : '—'}</td>
      <td className="px-4 py-3 text-right font-medium text-gray-700">{fleteHoy != null ? fmt(fleteHoy) : '—'}</td>
      <td className="px-4 py-3 text-right font-semibold text-gray-900 border-l border-gray-200">{b ? fmt(b.landedCostUsd) : '—'}</td>

      {/* ── Ruta marítima (CBM): lo que costaría la misma pieza por barco ── */}
      {maritimo && <>
      <td className="px-4 py-3 text-right text-sky-800 bg-sky-50/50 border-l-2 border-sky-200 text-xs font-mono">
        {m?.volumeM3 != null ? (
          <>
            {m.volumeM3.toFixed(3)}
            {multi && <span className="block text-sky-400">total: {(m.volumeM3 * quantity!).toFixed(3)}</span>}
          </>
        ) : <span className="text-sky-300" title="Faltan dimensiones">—</span>}
      </td>
      <td className="px-4 py-3 text-right text-sky-800 bg-sky-50/50">
        {fleteMar != null ? fmt(fleteMar) : <span className="text-sky-300" title="Faltan dimensiones">—</span>}
      </td>
      <td className="px-4 py-3 text-right font-semibold text-sky-900 bg-sky-50/50">
        {m ? fmt(m.landedCostUsd) : <span className="text-sky-300" title="Faltan dimensiones">—</span>}
      </td>
      <td className="px-4 py-3 text-right font-medium text-sky-900 bg-sky-50/50">
        {m?.priceUsd != null ? (
          <>
            {fmt(m.priceUsd)}
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
      </>}
      {cola}
    </>
  )
}

// Columnas de la tabla de /products: 4 fijas + las de costo + stock y acciones. Para que la
// fila desplegada ocupe el ancho entero.
const COLUMNAS = 4 + costHeaders().length + 2

export default function ProductRow({ product, cfg, activeSupplierId }: { product: ProductRowData; cfg: ConfigMap; activeSupplierId: number | null }) {
  // Override optimista: al guardar mostramos los valores nuevos al instante,
  // sin esperar el round-trip a la DB remota. Se limpia cuando llegan props
  // frescas del server (router.refresh), que son la fuente autoritativa.
  const [optimistic, setOptimistic] = useState<QuickEditValues | null>(null)
  // Por qué no se guardó la última edición. El modal ya se cerró (el guardado es optimista),
  // así que el aviso vive en la fila hasta que se descarte o se vuelva a guardar.
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null)

  // Cada refresh del server crea un product nuevo → descartamos el optimista
  // y volvemos a confiar en los datos reales. Se compara al renderizar contra el último
  // `product` visto (el patrón de React para derivar estado de una prop) en vez de un
  // efecto, que pintaba un render más con el valor optimista ya vencido.
  const [productVisto, setProductVisto] = useState(product)
  if (product !== productVisto) {
    setProductVisto(product)
    setOptimistic(null)
  }

  const [expanded, setExpanded] = useState(false)

  const d = optimistic ? { ...product, ...optimistic } : product
  const ensambles = product.assemblies
  const canExpand = ensambles.length > 0

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
                title={expanded ? 'Ocultar ensambles' : 'Ver ensambles'}
                className="shrink-0 text-gray-400 hover:text-gray-700 transition-transform w-4"
              >
                <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
              </button>
            )}
            <Link
              href={`/products/${d.id}`}
              className={`hover:text-blue-600 transition-colors truncate ${d.descontinuada ? 'text-gray-500 line-through' : ''}`}
            >
              {d.nameEs}
            </Link>
            <ChipDescontinuada activo={d.descontinuada} />
            {canExpand && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                title={ensambles.map((e) => e.nameEs).join(' · ')}
                className="shrink-0 text-[10px] font-semibold tracking-wide text-blue-600 bg-blue-50 hover:bg-blue-100 px-1.5 py-0.5 rounded"
              >
                {ensambles.length === 1 ? '1 ensamble' : `${ensambles.length} ensambles`}
              </button>
            )}
          </span>
          {d.nameEn && (
            <span className="block text-xs font-normal text-gray-400 truncate">{d.nameEn}</span>
          )}
          {errorGuardado && (
            <span role="alert" className="block text-xs font-normal text-red-600 whitespace-normal">
              No se guardó: {errorGuardado}{' '}
              <button type="button" onClick={() => setErrorGuardado(null)} className="underline">cerrar</button>
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 max-w-[140px] truncate" title={d.models.length ? formatModels(d.models) : undefined}>
          {d.models.length ? formatModels(d.models) : '—'}
        </td>
        <td className="px-4 py-3 text-right text-gray-500 text-xs">
          <span className="block">{d.weightGrams ?? '—'}</span>
          <IndicadorMedido medidoAt={d.medidoAt} className="mt-0.5" />
        </td>

        <CostCells d={d} cfg={cfg}  />

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
                models: product.models,
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
                descontinuada: product.descontinuada,
                medidoAt: product.medidoAt,
                stock: product.stock,
              }}
              onOptimistic={v => { setOptimistic(v); if (v) setErrorGuardado(null) }}
              onError={setErrorGuardado}
            />
            <DeleteButton action={deleteProduct.bind(null, product.id)} confirmMessage={`¿Eliminar "${product.nameEs}"?`} />
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-gray-50/60 text-xs">
          <td colSpan={COLUMNAS} className="pl-10 pr-4 py-2 whitespace-normal">
            <ul className="space-y-1">
              {ensambles.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-2 text-gray-700">
                  <span className="text-gray-300">└</span>
                  <Link href={`/ensambles/${e.id}`} className="hover:text-blue-600 transition-colors">{e.nameEs}</Link>
                  {e.models.length > 0 && <span className="text-gray-400">{formatModels(e.models)}</span>}
                  {e.quantity > 1 && <span className="text-gray-400">×{e.quantity}</span>}
                  {e.grupos.map((g) => (
                    <span key={g} className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{g}</span>
                  ))}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}
