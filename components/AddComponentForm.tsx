'use client'

import { useState, useEffect } from 'react'
import { buscarPiezas } from '@/app/(pages)/ensambles/component-actions'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import type { ActionResult } from '@/lib/action-result'

interface Product {
  id: number
  nameEs: string
  bajajCode: string | null
}

interface Props {
  ensambleId: number
  existingGroups: string[]
  action: (ensambleId: number, formData: FormData) => Promise<ActionResult>
}

export default function AddComponentForm({ ensambleId, existingGroups, action }: Props) {
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<Product[]>([])
  const q = search.trim()
  // Con el término corto no hay resultados: se deriva al renderizar en vez de vaciar el
  // estado desde el efecto.
  const filtered = q.length < 2 ? [] : found

  // Búsqueda contra la DB (debounce 250ms); no se cargan todos los productos.
  useEffect(() => {
    if (q.length < 2) return
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await buscarPiezas(q)
      if (!cancelled) setFound(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  const bound = action.bind(null, ensambleId)

  return (
    <FormConResultado action={bound} className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-3">
      <p className="text-sm font-medium text-gray-700">Agregar componente</p>

      <div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar pieza por nombre o código (2+ letras)..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-1"
        />
        <select
          name="productId"
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

      <PendingButton
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        + Agregar
      </PendingButton>
    </FormConResultado>
  )
}
