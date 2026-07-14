'use client'

import { useState, useEffect } from 'react'
import { searchProductsForPicker } from '@/app/(pages)/products/[id]/component-actions'

interface Product {
  id: number
  nameEs: string
  bajajCode: string | null
}

interface Props {
  parentId: number
  existingGroups: string[]
  action: (parentId: number, formData: FormData) => Promise<void>
}

export default function AddComponentForm({ parentId, existingGroups, action }: Props) {
  const [search, setSearch] = useState('')
  const [filtered, setFiltered] = useState<Product[]>([])

  // Búsqueda contra la DB (debounce 250ms); no se cargan todos los productos.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setFiltered([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await searchProductsForPicker(q, parentId)
      if (!cancelled) setFiltered(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, parentId])

  const bound = action.bind(null, parentId)

  return (
    <form action={bound} className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-3">
      <p className="text-sm font-medium text-gray-700">Agregar componente</p>

      <div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar pieza por nombre o código (2+ letras)..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-1"
        />
        <select
          name="childId"
          required
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Seleccionar pieza...</option>
          {filtered.map(p => (
            <option key={p.id} value={p.id}>
              {p.bajajCode ? `[${p.bajajCode}] ` : ''}{p.nameEs}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Grupo</label>
          <input
            name="groupName"
            list="existing-groups"
            placeholder="Ej: Fasteners, Spring..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <datalist id="existing-groups">
            {existingGroups.map(g => <option key={g} value={g} />)}
          </datalist>
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
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        + Agregar
      </button>
    </form>
  )
}
