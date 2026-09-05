import { db } from '@/lib/db'
import Link from 'next/link'
import ProductRow from '@/components/ProductRow'
import { costHeaders } from '@/lib/cost-columns'
import CatalogFilters from '@/components/CatalogFilters'
import { getCatalogFilters, whereModel } from '@/lib/catalog'
import { searchModels, fullModel, toModelIds } from '@/lib/modelo'
import { type ConfigMap } from '@/lib/calc'
import { getSupplierPriceMap } from '@/lib/suppliers'
import { toConfigMap } from '@/lib/config'
import { toInt } from '@/lib/parse'

interface SearchParams {
  search?: string
  model?: string
  category?: string
  page?: string
  lowStock?: string
  /** Contra qué proveedor comparar la columna 🚢. Es un filtro de ESTA pantalla, no un
   *  estado global: el proveedor de verdad lo elige cada embarque. */
  proveedor?: string
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const search = sp.search ?? ''
  const model = sp.model ?? ''
  const category = sp.category ?? ''
  const onlyLowStock = sp.lowStock === '1'
  // `parseInt('abc')` da NaN y NaN sobrevive a Math.max, así que entraba como
  // `skip: NaN` y Prisma tiraba: un 500 servible desde la barra de direcciones.
  const page = Math.max(1, toInt(sp.page) ?? 1)
  const limit = 20

  // El buscador también encuentra por moto ("n250", "dual abs"): el texto se traduce a
  // motos conocidas y de ahí a sus etiquetas, que es lo que guarda compatibleModels.
  const modelSearchLabels = searchModels(search).map(fullModel)

  const where = {
    AND: [
      search ? {
        OR: [
          { nameEs: { contains: search, mode: 'insensitive' as const } },
          { nameEn: { contains: search, mode: 'insensitive' as const } },
          { bajajCode: { contains: search, mode: 'insensitive' as const } },
          ...modelSearchLabels.map(label => ({ compatibleModels: { contains: label, mode: 'insensitive' as const } })),
        ]
      } : {},
      whereModel(model),
      category ? { nameEs: { equals: category, mode: 'insensitive' as const } } : {},
      onlyLowStock ? { stock: { lt: 5 } } : {},
      // Catálogo: ensambles + piezas sueltas (no incluidas en ningún ensamble).
      // Las piezas de un ensamble se ven desplegando el ensamble (dropdown en la fila).
      { OR: [{ isAssembly: true }, { assemblies: { none: {} } }] },
    ],
  }

  const proveedorId = parseInt(sp.proveedor ?? '')
  const compararContra = Number.isFinite(proveedorId) ? proveedorId : null

  const [products, total, configRows, filters, priceMap, suppliers] = await Promise.all([
    db.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        _count: { select: { components: true } },
        components: {
          orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }],
          include: { child: true },
        },
      },
    }),
    db.product.count({ where }),
    db.config.findMany(),
    getCatalogFilters(model),
    getSupplierPriceMap(compararContra),
    // Va dentro de la tanda: quedaba colgando después del Promise.all y era, sola, un
    // viaje entero a us-west-2 sin que nada dependiera de ella.
    db.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const supplierName = suppliers.find(s => s.id === compararContra)?.name ?? null

  const cfg = toConfigMap(configRows)
  const totalPages = Math.ceil(total / limit)

  // Preserva todos los filtros activos en los links de paginación.
  const pageUrl = (p: number) => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (model) params.set('model', model)
    if (category) params.set('category', category)
    if (onlyLowStock) params.set('lowStock', '1')
    if (compararContra != null) params.set('proveedor', String(compararContra))
    params.set('page', String(p))
    return `/products?${params.toString()}`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Productos</h1>

          {/* Las dos rutas se muestran siempre, lado a lado: el precio de venta sale del
              aéreo (siempre 99rpm), y el marítimo está al lado para decidir dónde
              abastecerse. Contra QUIÉN se compara el marítimo es un filtro de esta
              pantalla — el proveedor real lo elige cada embarque. */}
          <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
            ✈️ 99rpm · 🚢 {supplierName ?? '99rpm'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/products/discontinued" className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">
            Descontinuadas
          </Link>
          <Link href="/products/import" className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">
            Importar JSON
          </Link>
          <Link href="/products/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            + Nuevo Producto
          </Link>
        </div>
      </div>

      {/* Filtros: Modelo → Categoría (cascada) + buscador + stock bajo */}
      <CatalogFilters
        basePath="/products"
        models={filters.models}
        categories={filters.categories}
        current={{ model, category, search, lowStock: onlyLowStock }}
        showLowStock
        suppliers={suppliers}
        currentSupplierId={compararContra}
        searchPlaceholder="Buscar por nombre, código o modelo..."
      />

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        {products.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg">Sin productos</p>
            <p className="text-sm mt-1">
              <Link href="/products/new" className="text-blue-600 hover:underline">Agregar el primero</Link>
            </p>
          </div>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Código</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Nombre</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Modelos</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">g</th>
                {/* El set de columnas de costo depende del modo (ver costHeaders). */}
                {costHeaders().map(c => (
                  <th key={c.label} className={c.className} title={c.title}>{c.label}</th>
                ))}
                <th className="text-right px-4 py-3 font-medium text-gray-500 border-l border-gray-100">Stock</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {products.map((product) => (
                <ProductRow
                  key={product.id}
                  cfg={cfg}
                  activeSupplierId={compararContra}
                  product={{
                    id: product.id,
                    nameEs: product.nameEs,
                    nameEn: product.nameEn,
                    bajajCode: product.bajajCode,
                    models: toModelIds(product.compatibleModels),
                    priceInr: product.priceInr,
                    priceUsd: priceMap.get(product.id)?.priceUsd ?? null,
                    priceIsLanded: priceMap.get(product.id)?.isLanded ?? false,
                    weightGrams: product.weightGrams,
                    dimL: product.dimL,
                    dimA: product.dimA,
                    dimH: product.dimH,
                    margin: product.margin,
                    price: parseFloat(product.price.toString()),
                    priceLocked: product.priceLocked,
                    descontinuada: product.discontinuedAt != null,
                    stock: product.stock,
                    isAssembly: product.isAssembly,
                    componentsCount: product._count.components,
                    components: product.components.map((pc) => ({
                      id: pc.child.id,
                      quantity: pc.quantity,
                      groupName: pc.groupName,
                      nameEs: pc.child.nameEs,
                      nameEn: pc.child.nameEn,
                      bajajCode: pc.child.bajajCode,
                      models: toModelIds(pc.child.compatibleModels),
                      priceInr: pc.child.priceInr,
                      priceUsd: priceMap.get(pc.child.id)?.priceUsd ?? null,
                      priceIsLanded: priceMap.get(pc.child.id)?.isLanded ?? false,
                      weightGrams: pc.child.weightGrams,
                      dimL: pc.child.dimL,
                      dimA: pc.child.dimA,
                      dimH: pc.child.dimH,
                      margin: pc.child.margin,
                      price: parseFloat(pc.child.price.toString()),
                      priceLocked: pc.child.priceLocked,
                      descontinuada: pc.child.discontinuedAt != null,
                      stock: pc.child.stock,
                    })),
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-500">{total} productos — página {page} de {totalPages}</p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={pageUrl(page - 1)} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Anterior
              </Link>
            )}
            {page < totalPages && (
              <Link href={pageUrl(page + 1)} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Siguiente
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
