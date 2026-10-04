import { Fragment } from 'react'
import { db } from '@/lib/db'
import { formatModels, fullModel, toModelIds } from '@/lib/modelo'
import { nombreEnsamble } from '@/lib/linea-pedido'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import QuickEditProduct from '@/components/QuickEditProduct'
import { CostCells } from '@/components/ProductRow'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { costHeaders } from '@/lib/cost-columns'
import AddComponentForm from '@/components/AddComponentForm'
import MedidasIA from '@/components/MedidasIA'
import AssemblyImage from '@/components/AssemblyImage'
import { addComponent, removeComponent } from '../component-actions'
import { eliminarEnsamble } from '../actions'
import { getSupplierPriceMap } from '@/lib/suppliers'
import { toConfigMap } from '@/lib/config'

export default async function EnsambleDetailPage({
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

  const [ensamble, configRows] = await Promise.all([
    db.ensamble.findUnique({
      where: { id },
      include: {
        componentes: {
          include: { product: true },
          orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    db.config.findMany(),
  ])
  if (!ensamble) notFound()

  const priceMap = await getSupplierPriceMap(compararContra)
  const cfg = toConfigMap(configRows)
  // Sin tarifa por m³ el flete marítimo cuenta 0 y esa comparación sale falsamente barata.
  const tarifaMaritimaCargada = parseFloat(cfg.cbm_rate_usd ?? '') > 0

  const modelIds = toModelIds(ensamble.compatibleModels)
  const nombre = nombreEnsamble(ensamble)

  // Group components by groupName
  const groups = new Map<string, typeof ensamble.componentes>()
  for (const comp of ensamble.componentes) {
    const key = comp.groupName || '—'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(comp)
  }

  const existingGroups = Array.from(new Set(
    ensamble.componentes.map(c => c.groupName).filter((g): g is string => g !== '')
  ))

  // Piezas únicas del ensamble (una misma pieza puede repetirse en varios subgrupos),
  // para la carga de peso/dimensiones por JSON. La cantidad es la suma de sus apariciones
  // en el ensamble (x2 suspensión, x4 arandela…), como contexto para la IA.
  const qtyByPieza = new Map<number, number>()
  for (const c of ensamble.componentes) {
    qtyByPieza.set(c.product.id, (qtyByPieza.get(c.product.id) ?? 0) + c.quantity)
  }
  const uniqueParts = Array.from(
    new Map(ensamble.componentes.map(c => [c.product.id, c.product])).values()
  ).map(p => ({
    id: p.id,
    bajajCode: p.bajajCode,
    nameEs: p.nameEs,
    nameEn: p.nameEn,
    models: toModelIds(p.compatibleModels),
    weightGrams: p.weightGrams,
    // Las dimensiones viajan junto al peso: por mar el volumen es lo que se factura, así
    // que una pieza con peso pero sin caja sigue estando sin medir.
    dimL: p.dimL,
    dimA: p.dimA,
    dimH: p.dimH,
    quantity: qtyByPieza.get(p.id) ?? 1,
  }))

  return (
    <div className="max-w-7xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/groups" className="text-gray-400 hover:text-gray-600 text-sm">Ensambles</Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">{nombre}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{nombre}</h1>
          {ensamble.nameEn && ensamble.nameEn !== nombre && (
            <p className="text-sm text-gray-500 mt-0.5">{ensamble.nameEn}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/ensambles/${id}/edit`}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Editar
          </Link>
          <DeleteButton
            action={eliminarEnsamble.bind(null, id, true)}
            confirmMessage={`¿Eliminar "${nombre}"? Sus piezas quedan sueltas en el catálogo.`}
          />
        </div>
      </div>

      {/* Imagen del ensamble (con opción de descarga) */}
      {ensamble.imageUrl && (
        <AssemblyImage src={ensamble.imageUrl} name={nombre} />
      )}

      {/* Info general */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Modelos</p>
            <p className="font-medium text-gray-900" title={modelIds.length ? modelIds.map(fullModel).join(', ') : undefined}>
              {modelIds.length ? formatModels(modelIds) : '—'}
            </p>
          </div>
          {ensamble.sourceUrl && (
            <div className="sm:col-span-3">
              <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Fuente</p>
              <a href={ensamble.sourceUrl} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-xs break-all">
                {ensamble.sourceUrl}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Carga de peso/dimensiones (solo ensambles con piezas). Un solo grupo: este ensamble.
          El componente es el mismo que usan los presupuestos y los envíos, donde sí hay
          varios ensambles que elegir. El ensamble no tiene precio: el de un conjunto se
          calcula en el presupuesto sobre las piezas elegidas. */}
      {uniqueParts.length > 0 && (
        <MedidasIA
          ensambleId={id}
          grupos={[{ key: String(id), titulo: nombre, subtitulo: null, piezas: uniqueParts }]}
        />
      )}

      {/* Componentes */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">
          Componentes
          {ensamble.componentes.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-400">{ensamble.componentes.length} piezas</span>
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
                      const c = comp.product
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
                        models: toModelIds(c.compatibleModels),
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
          ensambleId={id}
          existingGroups={existingGroups}
          action={addComponent}
        />
      </div>

    </div>
  )
}
