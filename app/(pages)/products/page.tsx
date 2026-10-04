import { db } from '@/lib/db'
import Link from 'next/link'
import ProductRow, { type EnsambleDePieza } from '@/components/ProductRow'
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
  page?: string
  lowStock?: string
  /** Contra qué proveedor comparar la columna 🚢. Es un filtro de ESTA pantalla, no un
   *  estado global: el proveedor de verdad lo elige cada embarque. */
  proveedor?: string
}

/** Los ensambles de una pieza, uno por ensamble aunque la pieza esté en varios de sus grupos. */
function ensamblesDe(filas: { groupName: string; quantity: number; parent: { id: number; nameEs: string; bajajCode: string | null; compatibleModels: string | null } }[]): EnsambleDePieza[] {
  const porId = new Map<number, EnsambleDePieza>()
  for (const f of filas) {
    const previo = porId.get(f.parent.id)
    if (previo) {
      if (f.groupName && !previo.grupos.includes(f.groupName)) previo.grupos.push(f.groupName)
      continue
    }
    porId.set(f.parent.id, {
      id: f.parent.id,
      nameEs: f.parent.nameEs,
      bajajCode: f.parent.bajajCode,
      // Dos ensambles "Spark Plugs" se distinguen solo por la moto: sin ella la lista no sirve.
      models: toModelIds(f.parent.compatibleModels),
      grupos: f.groupName ? [f.groupName] : [],
      quantity: f.quantity,
    })
  }
  return [...porId.values()]
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const search = sp.search ?? ''
  const model = sp.model ?? ''
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
      onlyLowStock ? { stock: { lt: 5 } } : {},
      // Solo piezas: los ensambles ya tienen su pantalla (/groups). Cada pieza aparece
      // directamente, esté o no dentro de un ensamble, y la fila dice a cuáles pertenece.
      { isAssembly: false },
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
        // Un mismo hijo puede estar en varios grupos de un mismo ensamble (la unicidad es
        // parentId+childId+groupName): se colapsa por ensamble más abajo.
        assemblies: {
          orderBy: { parent: { nameEs: 'asc' } },
          select: {
            groupName: true,
            quantity: true,
            parent: { select: { id: true, nameEs: true, bajajCode: true, compatibleModels: true } },
          },
        },
      },
    }),
    db.product.count({ where }),
    db.config.findMany(),
    getCatalogFilters(model, { categorias: false }),
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

      {/* Filtros: modelo + buscador (nombre, SKU o moto) + stock bajo */}
      <CatalogFilters
        basePath="/products"
        models={filters.models}
        current={{ model, search, lowStock: onlyLowStock }}
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
                    assemblies: ensamblesDe(product.assemblies),
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
