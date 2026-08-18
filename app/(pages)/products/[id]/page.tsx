import { Fragment } from 'react'
import { db } from '@/lib/db'
import { formatModels, fullModel } from '@/lib/modelo'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import QuickEditProduct from '@/components/QuickEditProduct'
import { CostCells } from '@/components/ProductRow'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { costHeaders } from '@/lib/cost-columns'
import AddComponentForm from '@/components/AddComponentForm'
import AddToAssemblyForm from '@/components/AddToAssemblyForm'
import MedidasIA from '@/components/MedidasIA'
import AssemblyImage from '@/components/AssemblyImage'
import BundlePriceEditor from '@/components/BundlePriceEditor'
import { addComponent, removeComponent, addToAssembly } from './component-actions'
import { deleteProduct } from '../actions'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { getSupplierPriceMap } from '@/lib/suppliers'

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
        components: {
          include: { child: true },
          orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        },
        assemblies: {
          include: { parent: true },
        },
      },
    }),
    db.config.findMany(),
  ])

  if (!product) notFound()

  const priceMap = await getSupplierPriceMap(compararContra)
  const supplierOverride = priceMap.get(product.id) ?? null

  const cfg = configRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const fisico = {
    weightGrams: product.weightGrams,
    dimL:        product.dimL,
    dimA:        product.dimA,
    dimH:        product.dimH,
    margin:      product.margin,
  }
  // Aéreo: siempre 99rpm (ningún otro proveedor llega al mínimo de Shoppre).
  // Marítimo: el proveedor elegido, que es a quien se le compra por barco.
  const forCalc = { ...fisico, priceInr: product.priceInr, priceUsd: null, priceIsLanded: false }
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
  // Sin tarifa por m³ el flete marítimo cuenta 0 y esa comparación sale falsamente barata.
  const tarifaMaritimaCargada = parseFloat(cfg.cbm_rate_usd ?? '') > 0

  // Group components by groupName
  const groups = new Map<string, typeof product.components>()
  for (const comp of product.components) {
    const key = comp.groupName || '—'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(comp)
  }

  const existingGroups = Array.from(new Set(
    product.components.map(c => c.groupName).filter((g): g is string => g !== '')
  ))

  // Piezas únicas del ensamble (una misma pieza puede repetirse en varios subgrupos),
  // para la carga de peso/dimensiones por JSON. La cantidad es la suma de sus apariciones
  // en el ensamble (x2 suspensión, x4 arandela…), como contexto para la IA.
  const qtyByChild = new Map<number, number>()
  for (const c of product.components) {
    qtyByChild.set(c.child.id, (qtyByChild.get(c.child.id) ?? 0) + c.quantity)
  }
  const uniqueParts = Array.from(
    new Map(product.components.map(c => [c.child.id, c.child])).values()
  ).map(child => ({
    id: child.id,
    bajajCode: child.bajajCode,
    nameEs: child.nameEs,
    nameEn: child.nameEn,
    models: child.models,
    weightGrams: child.weightGrams,
    // Las dimensiones viajan junto al peso: por mar el volumen es lo que se factura, así
    // que una pieza con peso pero sin caja sigue estando sin medir.
    dimL: child.dimL,
    dimA: child.dimA,
    dimH: child.dimH,
    quantity: qtyByChild.get(child.id) ?? 1,
  }))

  // Suma de las piezas (precio × cantidad) — referencia para el precio del conjunto.
  const partsSum = product.components.reduce(
    (s, c) => s + parseFloat(c.child.price.toString()) * c.quantity, 0
  )

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
            action={deleteProduct.bind(null, id)}
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
            <p className="font-medium text-gray-900" title={product.models.length ? product.models.map(fullModel).join(', ') : undefined}>
              {product.models.length ? formatModels(product.models) : '—'}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Peso</p>
            <p className="font-medium text-gray-900">{product.weightGrams ? `${product.weightGrams} g` : '—'}</p>
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
            {breakdown.priceBsd != null && (
              <div className="flex justify-between py-1.5 text-gray-700 font-semibold">
                <span>Precio venta (BsD)</span>
                <span>Bs.{breakdown.priceBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}</span>
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
                <Link href={`/products/${a.parent.id}`} className="text-blue-600 hover:underline font-medium">
                  {a.parent.nameEs}
                </Link>
                <span className="text-xs text-gray-500">
                  {a.groupName ? `Grupo: ${a.groupName}` : ''} · {a.quantity}x
                </span>
              </div>
            ))}
          </div>
        )}
        <AddToAssemblyForm
          childId={id}
          action={addToAssembly}
        />
      </div>

      {/* Precio del conjunto + carga de peso/dimensiones (solo ensambles con piezas) */}
      {product.isAssembly && uniqueParts.length > 0 && (
        <>
          <BundlePriceEditor
            assemblyId={id}
            currentPrice={parseFloat(product.price.toString())}
            priceLocked={product.priceLocked}
            partsSum={partsSum}
          />
          {/* Un solo grupo: este ensamble. El componente es el mismo que usan los
              presupuestos y los envíos, donde sí hay varios ensambles que elegir. */}
          <MedidasIA
            assemblyId={id}
            grupos={[{ key: String(id), titulo: product.nameEs, subtitulo: product.bajajCode, piezas: uniqueParts }]}
          />
        </>
      )}

      {/* Componentes */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">
          Componentes
          {product.components.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-400">{product.components.length} piezas</span>
          )}
        </h2>

        {groups.size === 0 ? (
          <p className="text-sm text-gray-400 mb-4">Sin componentes registrados.</p>
        ) : (
          <>
          {!tarifaMaritimaCargada && (
            <p className="text-xs mb-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
              ⚠️ No hay tarifa por m³ cargada: las columnas 🚢 cuentan flete 0 y el landed marítimo
              de estas piezas sale falsamente barato. Cargá{' '}
              <Link href="/config" className="font-mono underline">cbm_rate_usd</Link> en Configuración.
            </p>
          )}
          <div className="overflow-x-auto -mx-6 mb-6">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-400">
                  <th className="text-right font-medium px-2 py-2 w-10">Cant</th>
                  <th className="text-left font-medium px-2 py-2">Componente</th>
                  <th className="text-left font-medium px-2 py-2">Código</th>
                  <th className="text-right font-medium px-2 py-2">Peso (g)</th>
                  <th className="text-right font-medium px-2 py-2">L×A×H (cm)</th>
                  {costHeaders('compact').map(c => (
                    <th key={c.label} className={c.className} title={c.title}>{c.label}</th>
                  ))}
                  <th className="text-right font-medium px-2 py-2">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {Array.from(groups.entries()).map(([groupName, items]) => (
                  <Fragment key={groupName}>
                    {groupName !== '—' && (
                      <tr>
                        <td colSpan={20} className="px-2 pt-4 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          {groupName}
                        </td>
                      </tr>
                    )}
                    {items.map(comp => {
                      const c = comp.child
                      // priceInr/weightGrams/dims se guardan SIEMPRE por unidad. Peso y dims
                      // muestran el TOTAL de la línea (unitario × cantidad) como valor principal,
                      // con el peso "c/u" al lado en chico (ver QuickEditProduct, mismo criterio
                      // al editar). El alto (dimH) se asume apilado × cantidad para estimar la
                      // caja de envío; largo/ancho son la huella de una sola unidad. El desglose
                      // de costo (₹INR en adelante) es el mismo componente CostCells de la lista
                      // de productos, con `quantity` para mostrar el total de esta línea.
                      const dims = [c.dimL, c.dimA, c.dimH != null ? +(c.dimH * comp.quantity).toFixed(2) : null]
                      const hasDims = dims.some(d => d != null)
                      const lineWeight = c.weightGrams != null ? c.weightGrams * comp.quantity : null
                      const costD = {
                        id: c.id,
                        nameEs: c.nameEs,
                        nameEn: c.nameEn,
                        bajajCode: c.bajajCode,
                        models: c.models,
                        priceInr: c.priceInr,
                        priceUsd: priceMap.get(c.id)?.priceUsd ?? null,
                        priceIsLanded: priceMap.get(c.id)?.isLanded ?? false,
                        weightGrams: c.weightGrams,
                        dimL: c.dimL,
                        dimA: c.dimA,
                        dimH: c.dimH,
                        margin: c.margin,
                        price: parseFloat(c.price.toString()),
                        priceLocked: c.priceLocked,
                        descontinuada: c.discontinuedAt != null,
                        stock: c.stock,
                      }
                      return (
                        <tr key={comp.id} className="hover:bg-gray-50">
                          <td className="px-2 py-2 text-right text-gray-400">{comp.quantity}×</td>
                          <td className="px-2 py-2">
                            <Link
                              href={`/products/${c.id}`}
                              className={`font-medium hover:text-blue-600 ${c.discontinuedAt ? 'text-gray-500 line-through' : 'text-gray-900'}`}
                            >
                              {c.nameEs}
                            </Link>
                            <ChipDescontinuada activo={c.discontinuedAt != null} />
                            {c.nameEn && <span className="block text-xs text-gray-400">{c.nameEn}</span>}
                          </td>
                          <td className="px-2 py-2 font-mono text-xs text-gray-500">{c.bajajCode ?? '—'}</td>
                          <td className={`px-2 py-2 text-right font-mono ${lineWeight == null ? 'text-red-400' : 'text-gray-700'}`}>
                            {lineWeight ?? '—'}
                            {comp.quantity > 1 && c.weightGrams != null && (
                              <span className="block text-[10px] text-gray-400 font-normal">{c.weightGrams} g c/u</span>
                            )}
                          </td>
                          <td className={`px-2 py-2 text-right font-mono ${!hasDims ? 'text-red-400' : 'text-gray-700'}`}>
                            {hasDims ? dims.map(d => d ?? '—').join('×') : '—'}
                            {comp.quantity > 1 && c.dimH != null && (
                              <span className="block text-[10px] text-gray-400 font-normal">alto {c.dimH} c/u × {comp.quantity}</span>
                            )}
                          </td>
                          <CostCells d={costD} cfg={cfg} quantity={comp.quantity} />
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-end gap-3">
                              <QuickEditProduct
                                cfg={cfg}
                                activeSupplierId={compararContra}
                                triggerClassName="text-xs text-blue-600 hover:text-blue-800 font-medium"
                                packQty={comp.quantity}
                                product={costD}
                              />
                              <DeleteButton
                                action={removeComponent.bind(null, id, comp.id)}
                                confirmMessage={`¿Quitar "${c.nameEs}" de este ensamble?`}
                              />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}

        <AddComponentForm
          parentId={id}
          existingGroups={existingGroups}
          action={addComponent}
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
