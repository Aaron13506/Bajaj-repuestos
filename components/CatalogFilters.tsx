'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Props {
  basePath: string          // '/groups' o '/products'
  models: string[]          // los 14 modelos
  categories: string[]      // categorías ya scopeadas al modelo actual
  current: { model: string; category: string; search: string; lowStock?: boolean }
  showLowStock?: boolean
  searchPlaceholder?: string
}

export default function CatalogFilters({
  basePath,
  models,
  categories,
  current,
  showLowStock = false,
  searchPlaceholder = 'Buscar por nombre o código...',
}: Props) {
  const router = useRouter()
  const [category, setCategory] = useState(current.category)
  const [search, setSearch] = useState(current.search)
  const [lowStock, setLowStock] = useState(!!current.lowStock)

  // Navega reseteando la página. Los overrides pisan el estado local.
  function go(next: Partial<{ model: string; category: string; search: string; lowStock: boolean }>) {
    const model = next.model ?? current.model
    const cat = next.category ?? category
    const s = next.search ?? search
    const ls = next.lowStock ?? lowStock
    const p = new URLSearchParams()
    if (model) p.set('model', model)
    if (cat) p.set('category', cat)
    if (s) p.set('search', s)
    if (ls) p.set('lowStock', '1')
    const qs = p.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  const hasFilters = !!(current.model || category || search || lowStock)

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); go({}) }}
      className="flex flex-wrap gap-3 mb-6"
    >
      {/* Modelo — al cambiar, recarga y limpia la categoría (que pertenecía al modelo viejo) */}
      <select
        value={current.model}
        onChange={(e) => { setCategory(''); go({ model: e.target.value, category: '' }) }}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
      >
        <option value="">Todos los modelos</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      {/* Categoría — scopeada al modelo actual */}
      <input
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        list="catalog-categories"
        placeholder={current.model ? 'Categoría de este modelo...' : 'Categoría (Swing Arm...)'}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-56"
      />
      <datalist id="catalog-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={searchPlaceholder}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-64"
      />

      {showLowStock && (
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(e) => { setLowStock(e.target.checked); go({ lowStock: e.target.checked }) }}
          />
          Solo stock bajo
        </label>
      )}

      <button type="submit" className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-900 transition-colors">
        Filtrar
      </button>
      {hasFilters && (
        <button
          type="button"
          onClick={() => router.push(basePath)}
          className="text-sm text-gray-500 hover:text-gray-700 self-center"
        >
          Limpiar
        </button>
      )}
    </form>
  )
}
