'use client'

import { useState, useEffect } from 'react'
import { searchProductsForPicker } from '@/app/(pages)/products/[id]/component-actions'

interface Product {
  id: number
  nameEs: string
  bajajCode: string | null
}

interface Props {
  childId: number
  action: (childId: number, formData: FormData) => Promise<void>
}

export default function AddToAssemblyForm({ childId, action }: Props) {
  const [search, setSearch] = useState('')
  const [filtered, setFiltered] = useState<Product[]>([])

  // Búsqueda de ensambles contra la DB (debounce 250ms); no se cargan todos.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setFiltered([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await searchProductsForPicker(q, childId, true)
      if (!cancelled) setFiltered(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, childId])

  const bound = action.bind(null, childId)

  return (
    <form action={bound} className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-3 mt-3">
      <p className="text-sm font-medium text-gray-700">Agregar a un ensamble</p>

      <div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar ensamble por nombre o código (2+ letras)..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-1"
        />
        <select
          name="parentId"
          required
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Seleccionar ensamble...</option>
          {filtered.map(p => (
            <option key={p.id} value={p.id}>
              {p.bajajCode ? `[${p.bajajCode}] ` : ''}{p.nameEs}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Grupo dentro del ensamble</label>
          <input
            name="groupName"
            placeholder="Ej: Fasteners, Spring..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Cantidad</label>
          <input
            name="quantity"
            type="number"
            min="1"
            defaultValue="1"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      <button
        type="submit"
        className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
      >
        + Agregar a ensamble
      </button>
    </form>
  )
}
