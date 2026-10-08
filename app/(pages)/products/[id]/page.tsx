import { db } from '@/lib/db'
import IndicadorMedido from '@/components/IndicadorMedido'
import { formatModels, fullModel, toModelIds } from '@/lib/modelo'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import AddToAssemblyForm from '@/components/AddToAssemblyForm'
import AssemblyImage from '@/components/AssemblyImage'
import { addToAssembly } from '../../ensambles/component-actions'
import { deleteProduct } from '../actions'
import { calcLanded } from '@/lib/calc'
import { getSupplierPriceMap } from '@/lib/suppliers'
import { toConfigMap } from '@/lib/config'

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ proveedor?: string }>
}) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  // Contra qué proveedor comparar la columna marítima. Filtro de pantalla, no estado
  // global: el proveedor con el que se compra de verdad lo elige cada embarque.
  const proveedorId = parseInt((await searchParams).proveedor ?? '')
  const compararContra = Number.isFinite(proveedorId) ? proveedorId : null

  const [product, configRows] = await Promise.all([
    db.product.findUnique({
      where: { id },
      include: {
        assemblies: {
          include: { ensamble: { select: { id: true, nameEs: true, compatibleModels: true } } },
        },
      },
    }),
    db.config.findMany(),
  ])

  if (!product) {
    // Los ensambles salieron de `Product` conservando su id, así que un link o un favorito a
    // /products/<id> de un ensamble viejo sigue llegando acá. Product no reusa ids: si no hay
    // pieza con ese id y sí un ensamble, es el mismo objeto de antes.
    const ensamble = await db.ensamble.findUnique({ where: { id }, select: { id: true } })
    if (ensamble) redirect(`/ensambles/${ensamble.id}`)
    notFound()
  }

  const priceMap = await getSupplierPriceMap(compararContra)
  const supplierOverride = priceMap.get(product.id) ?? null

  const cfg = toConfigMap(configRows)
  const fisico = {
    weightGrams: product.weightGrams,
    dimL:        product.dimL,
    dimA:        product.dimA,
    dimH:        product.dimH,
    margin:      product.margin,
  }
  // Aéreo: siempre 99rpm (ningún otro proveedor llega al mínimo de Shoppre).
  // Marítimo: el proveedor elegido, que es a quien se le compra por barco.
  const forCalc = {
    ...fisico, priceInr: product.priceInr, priceUsd: null, priceIsLanded: false,
    // Precio fijo: el escrito manda, no se recompone desde el margen.
    precioFijo: product.priceLocked ? Number(product.price) : null,
  }
  const forMar = {
    ...fisico,
    priceInr:      product.priceInr,
    priceUsd:      supplierOverride?.priceUsd ?? null,
    priceIsLanded: supplierOverride?.isLanded ?? false,
  }
  // El desglose de la ficha es el AÉREO: es la ruta por la que sale lo que se vende, y de
  // ahí sale el precio. El marítimo aparece como columna de comparación en la tabla de
  // componentes, que es donde la pregunta "¿conviene por barco?" tiene sentido.
  const breakdown = calcLanded(forCalc, cfg, 'aereo')
  const breakdownMar = calcLanded(forMar, cfg, 'maritimo_cbm')

  return (
    <div className="max-w-7xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/products" className="text-gray-400 hover:text-gray-600 text-sm">Productos</Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">{product.nameEs}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className={`text-2xl font-bold ${product.discontinuedAt ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
              {product.nameEs}
            </h1>
            {/* Va en el título y no en la ficha de costos: el costo sigue calculándose y se
                ve razonable, y esa es justamente la trampa — el número existe pero la compra
                no. Enterarse recién al intentar agregarla al embarque es tarde. */}
            {product.discontinuedAt && (
              <span
                className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-800"
                title={`Marcada el ${product.discontinuedAt.toISOString().slice(0, 10)}`}
              >
                Descontinuada de fábrica
              </span>
            )}
          </div>
          {product.discontinuedAt && (
            <p className="text-sm text-red-700 mt-1">
              Bajaj no la fabrica más: no la consigue ningún proveedor, así que no entra en embarques ni en
              presupuestos.{product.stock > 0 && ` Te quedan ${product.stock} en stock — eso sí se puede vender.`}
            </p>
          )}
          {product.nameEn && (
            <p className="text-sm text-gray-500 mt-0.5">{product.nameEn}</p>
          )}
          {product.bajajCode && (
            <p className="text-sm font-mono text-gray-500 mt-0.5">{product.bajajCode}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/products/${id}/edit`}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Editar
          </Link>
          <DeleteButton
            action={deleteProduct.bind(null, id, true)}
            confirmMessage={`¿Eliminar "${product.nameEs}"?`}
          />
        </div>
      </div>

      {/* Imagen del producto (con opción de descarga) */}
      {product.imageUrl && (
        <AssemblyImage src={product.imageUrl} name={product.nameEs} />
      )}

      {/* Info general */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Modelos</p>
            <p className="font-medium text-gray-900" title={toModelIds(product.compatibleModels).length ? toModelIds(product.compatibleModels).map(fullModel).join(', ') : undefined}>
              {toModelIds(product.compatibleModels).length ? formatModels(toModelIds(product.compatibleModels)) : '—'}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Peso</p>
            <p className="font-medium text-gray-900">{product.weightGrams ? `${product.weightGrams} g` : '—'}</p>
            {/* Cubre peso Y dimensiones: se miden juntos. */}
            <IndicadorMedido medidoAt={product.medidoAt} className="mt-1" />
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Dimensiones (cm)</p>
            <p className="font-medium text-gray-900">
              {product.dimL && product.dimA && product.dimH
                ? `${product.dimL} × ${product.dimA} × ${product.dimH}`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Stock</p>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              product.stock === 0 ? 'bg-red-100 text-red-700'
                : product.stock < 5 ? 'bg-yellow-100 text-yellow-700'
                : 'bg-green-100 text-green-700'
            }`}>
              {product.stock} uds.
            </span>
          </div>
          {product.sourceUrl && (
            <div className="sm:col-span-2">
              <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Fuente</p>
              <a href={product.sourceUrl} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-xs break-all">
                {product.sourceUrl}
              </a>
            </div>
          )}
        </div>
        {(product.description || product.notes) && (
          <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
            {product.description && <p className="text-sm text-gray-700">{product.description}</p>}
            {product.notes && <p className="text-xs text-gray-500 italic">{product.notes}</p>}
          </div>
        )}
      </div>

      {/* Desglose de costos */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Desglose de costo</h2>

        {!breakdown ? (
          <p className="text-sm text-gray-400">Completá el precio en India (₹) y el peso para ver el cálculo.</p>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex justify-between py-1.5 border-b border-gray-50">
              <span className="text-gray-600">
                {supplierOverride != null ? 'Precio proveedor' : 'Precio India'}
                {supplierOverride?.isLanded && (
                  <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                    Landed
                  </span>
                )}
              </span>
              <span className="font-mono text-gray-500">
                {supplierOverride != null
                  ? `$${supplierOverride.priceUsd.toFixed(2)}`
                  : product.priceInr ? `₹${product.priceInr}` : '—'}
              </span>
            </div>
            <div className="flex justify-between py-1.5">
              <span className="text-gray-600">Producto (USD)</span>
              <span className="font-mono">${breakdown.productCostUsd.toFixed(2)}</span>
            </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-gray-600">Envío Shoppre India → USA</span>
                  <span className="font-mono">${breakdown.shoppreShippingUsd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-gray-600">Seguro Shoppre</span>
                  <span className="font-mono">${breakdown.insuranceUsd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-gray-600">Flete marítimo Miami → CCS</span>
                  <span className="font-mono">${breakdown.maritimeUsd.toFixed(2)}</span>
                </div>
            <div className="flex justify-between py-2 border-t border-gray-200 font-semibold text-gray-900">
              <span>✈️ Costo landed (USD)</span>
              <span className="font-mono">${breakdown.landedCostUsd.toFixed(2)}</span>
            </div>

            {/* La misma pieza por la otra ruta. No cambia el precio de venta (eso sale del
                aéreo, que es por donde salen los pedidos), pero es la respuesta a si
                conviene traerla por barco para stock. */}
            <div className="mt-2 rounded-lg bg-sky-50 border border-sky-100 px-3 py-2 space-y-1">
              <div className="flex justify-between text-sky-900">
                <span>🚢 Landed por mar (CBM)</span>
                <span className="font-mono font-semibold">
                  {breakdownMar ? `$${breakdownMar.landedCostUsd.toFixed(2)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between text-xs text-sky-700">
                <span>{breakdownMar?.volumeM3 != null ? `${breakdownMar.volumeM3.toFixed(3)} m³ · flete $${breakdownMar.maritimeUsd.toFixed(2)}` : 'Faltan dimensiones'}</span>
                {breakdownMar && breakdown.landedCostUsd > 0 && (
                  <span className={`font-semibold ${
                    breakdownMar.landedCostUsd < breakdown.landedCostUsd ? 'text-green-700' : 'text-red-600'
                  }`}>
                    {breakdownMar.landedCostUsd < breakdown.landedCostUsd ? '−' : '+'}
                    {Math.abs(((breakdownMar.landedCostUsd - breakdown.landedCostUsd) / breakdown.landedCostUsd) * 100).toFixed(0)}% vs aéreo
                  </span>
                )}
              </div>
            </div>

            <div className="flex justify-between py-1.5 border-t border-gray-100 text-gray-600">
              <span>Margen</span>
              <span>{product.margin != null ? `${+(product.margin * 100).toFixed(2)}%` : '—'}</span>
            </div>
            <div className="flex justify-between py-2 text-blue-700 font-bold text-base">
              <span>Precio venta (USD)</span>
              <span>${(breakdown.priceUsd ?? parseFloat(product.price.toString())).toFixed(2)}</span>
            </div>
            {breakdown.priceBcv != null && (
              <div className="flex justify-between py-1.5 text-gray-700 font-semibold">
                <span title="Precio a COTIZAR en USD cuando se cobra a tasa oficial: precio de venta + la brecha del día, redondeada al escalón de 5% arriba">
                  Precio a cotizar (BCV)
                </span>
                <span>${breakdown.priceBcv.priceUsdBcv.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Forma parte de */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-3">Forma parte de</h2>
        {product.assemblies.length === 0 ? (
          <p className="text-sm text-gray-400">No asignado a ningún ensamble.</p>
        ) : (
          <div className="space-y-2 mb-1">
            {product.assemblies.map(a => (
              <div key={a.id} className="flex items-center justify-between text-sm">
                <Link href={`/ensambles/${a.ensamble.id}`} className="text-blue-600 hover:underline font-medium">
                  {a.ensamble.nameEs}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    {formatModels(toModelIds(a.ensamble.compatibleModels))}
                  </span>
                </Link>
                <span className="text-xs text-gray-500">
                  {a.groupName ? `Grupo: ${a.groupName}` : ''} · {a.quantity}x
                </span>
              </div>
            ))}
          </div>
        )}
        <AddToAssemblyForm
          productId={id}
          action={addToAssembly}
        />
      </div>

    </div>
  )
}

function CompareRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono text-gray-800">${value.toFixed(2)}</dd>
    </div>
  )
}
