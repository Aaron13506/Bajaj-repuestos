import { db } from '@/lib/db'
import Link from 'next/link'
import ProductRow from '@/components/ProductRow'
import CatalogFilters from '@/components/CatalogFilters'
import { getCatalogFilters } from '@/lib/catalog'
import { type ConfigMap } from '@/lib/calc'
import { getActiveSupplier, getSupplierPriceMap } from '@/lib/suppliers'

interface SearchParams {
  search?: string
  model?: string
  category?: string
  page?: string
  lowStock?: string
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const search = sp.search ?? ''
  const model = sp.model ?? ''
  const category = sp.category ?? ''
  const onlyLowStock = sp.lowStock === '1'
  const page = Math.max(1, parseInt(sp.page ?? '1'))
  const limit = 20

  const where = {
    AND: [
      search ? {
        OR: [
          { nameEs: { contains: search, mode: 'insensitive' as const } },
          { nameEn: { contains: search, mode: 'insensitive' as const } },
          { bajajCode: { contains: search, mode: 'insensitive' as const } },
          { compatibleModels: { contains: search, mode: 'insensitive' as const } },
        ]
      } : {},
      model ? { compatibleModels: { contains: model, mode: 'insensitive' as const } } : {},
      category ? { nameEs: { equals: category, mode: 'insensitive' as const } } : {},
      onlyLowStock ? { stock: { lt: 5 } } : {},
      // Catálogo: ensambles + piezas sueltas (no incluidas en ningún ensamble).
      // Las piezas de un ensamble se ven desplegando el ensamble (dropdown en la fila).
      { OR: [{ isAssembly: true }, { assemblies: { none: {} } }] },
    ],
  }

  const activeSupplier = await getActiveSupplier()

  const [products, total, configRows, filters, priceMap] = await Promise.all([
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
    getSupplierPriceMap(activeSupplier?.id ?? null),
  ])

  const cfg = configRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const totalPages = Math.ceil(total / limit)

  // Preserva todos los filtros activos en los links de paginación.
  const pageUrl = (p: number) => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (model) params.set('model', model)
    if (category) params.set('category', category)
    if (onlyLowStock) params.set('lowStock', '1')
    params.set('page', String(p))
    return `/products?${params.toString()}`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Productos</h1>
          <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
            Proveedor: {activeSupplier?.name ?? '99rpm (base)'}
          </span>
        </div>
        <div className="flex items-center gap-2">
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
                <th className="text-right px-4 py-3 font-medium text-gray-500 border-l border-gray-100">Costo origen</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Producto</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Shoppre</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Seguro</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Marítimo</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Flete hoy</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 font-semibold border-l border-gray-200">Landed</th>
                <th className="text-right px-4 py-3 font-medium text-sky-700 bg-sky-50 border-l-2 border-sky-200" title="Flete India → Venezuela por mar directo">🚢 Flete mar</th>
                <th className="text-right px-4 py-3 font-semibold text-sky-800 bg-sky-50" title="Costo landed si se trae por mar directo">Landed mar</th>
                <th className="text-right px-4 py-3 font-medium text-sky-700 bg-sky-50" title="Precio de venta por mar: mismo margen aplicado sobre el landed marítimo">Venta mar</th>
                <th className="text-right px-4 py-3 font-medium text-sky-700 bg-sky-50 border-r-2 border-sky-200" title="Diferencia contra el aéreo actual — igual para landed y para venta">Δ</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 border-l border-gray-100">Margen</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Precio USD</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Precio BsD</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 border-l border-gray-100">Stock</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {products.map((product) => (
                <ProductRow
                  key={product.id}
                  cfg={cfg}
                  activeSupplierId={activeSupplier?.id ?? null}
                  product={{
                    id: product.id,
                    nameEs: product.nameEs,
                    nameEn: product.nameEn,
                    bajajCode: product.bajajCode,
                    compatibleModels: product.compatibleModels,
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
                      compatibleModels: pc.child.compatibleModels,
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
