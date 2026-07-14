import { db } from '@/lib/db'
import Link from 'next/link'
import { getCatalogFilters } from '@/lib/catalog'
import CatalogFilters from '@/components/CatalogFilters'

interface SearchParams {
  model?: string
  category?: string
  search?: string
  page?: string
}

export default async function GroupsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const model = sp.model ?? ''
  const category = sp.category ?? ''
  const search = sp.search ?? ''
  const page = Math.max(1, parseInt(sp.page ?? '1'))
  const limit = 25

  const where = {
    AND: [
      { isAssembly: true },
      model ? { compatibleModels: { contains: model, mode: 'insensitive' as const } } : {},
      category ? { nameEs: { equals: category, mode: 'insensitive' as const } } : {},
      search
        ? {
            OR: [
              { nameEs: { contains: search, mode: 'insensitive' as const } },
              { nameEn: { contains: search, mode: 'insensitive' as const } },
              { bajajCode: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {},
    ],
  }

  const [groups, total, filters] = await Promise.all([
    db.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
      include: {
        components: {
          include: { child: { select: { id: true, nameEs: true, bajajCode: true, price: true } } },
          orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    db.product.count({ where }),
    getCatalogFilters(model),
  ])

  const totalPages = Math.ceil(total / limit)
  const hasFilters = !!(model || category || search)

  // Preserva los filtros en los links de paginación.
  const qs = (p: number) => {
    const params = new URLSearchParams()
    if (model) params.set('model', model)
    if (category) params.set('category', category)
    if (search) params.set('search', search)
    params.set('page', String(p))
    return `/groups?${params.toString()}`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Ensambles</h1>
        <Link href="/products/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
          + Nuevo ensamble
        </Link>
      </div>

      {/* Filtros: Modelo → Categoría (cascada) + buscador */}
      <CatalogFilters
        basePath="/groups"
        models={filters.models}
        categories={filters.categories}
        current={{ model, category, search }}
      />

      {total > 0 && (
        <p className="text-sm text-gray-500 mb-3">
          {total} {total === 1 ? 'ensamble' : 'ensambles'}
          {totalPages > 1 && ` — página ${page} de ${totalPages}`}
        </p>
      )}

      {groups.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin ensambles</p>
          <p className="text-sm mt-1">
            {hasFilters ? 'Probá con otros filtros o ' : 'Creá un producto y marcá "Es un ensamble", o '}
            <Link href="/groups" className="text-blue-600 hover:underline">limpiá los filtros</Link>.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const subGroups = new Map<string, typeof group.components>()
            for (const comp of group.components) {
              const key = comp.groupName || '—'
              if (!subGroups.has(key)) subGroups.set(key, [])
              subGroups.get(key)!.push(comp)
            }

            return (
              <div key={group.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* Header del ensamble */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {group.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={group.imageUrl}
                        alt={group.nameEs}
                        loading="lazy"
                        className="w-14 h-14 object-contain rounded-lg border border-gray-100 bg-white shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <Link href={`/products/${group.id}`} className="font-semibold text-gray-900 hover:text-blue-600">
                        {group.nameEs}
                      </Link>
                      {group.bajajCode && (
                        <span className="ml-2 text-xs font-mono text-gray-400">{group.bajajCode}</span>
                      )}
                      {group.compatibleModels && (
                        <span className="ml-2 text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{group.compatibleModels}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-400">
                      {group.components.length} {group.components.length === 1 ? 'pieza' : 'piezas'}
                      {subGroups.size > 0 && ` · ${subGroups.size} sub-grupos`}
                    </span>
                    <Link href={`/products/${group.id}`} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                      Editar
                    </Link>
                  </div>
                </div>

                {/* Sub-grupos y productos */}
                {subGroups.size > 0 && (
                  <div className="divide-y divide-gray-50">
                    {Array.from(subGroups.entries()).map(([subGroup, items]) => (
                      <div key={subGroup} className="px-6 py-3">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{subGroup}</p>
                        <div className="space-y-1">
                          {items.map((comp) => (
                            <div key={comp.id} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-gray-400 text-xs w-5 text-right shrink-0">{comp.quantity}×</span>
                                <Link href={`/products/${comp.child.id}`} className="text-gray-800 hover:text-blue-600 truncate">
                                  {comp.child.nameEs}
                                </Link>
                                {comp.child.bajajCode && (
                                  <span className="text-xs font-mono text-gray-400 shrink-0">{comp.child.bajajCode}</span>
                                )}
                              </div>
                              <span className="text-gray-500 text-xs shrink-0">
                                ${parseFloat(comp.child.price.toString()).toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-500">página {page} de {totalPages}</p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={qs(page - 1)} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Anterior
              </Link>
            )}
            {page < totalPages && (
              <Link href={qs(page + 1)} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Siguiente
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}