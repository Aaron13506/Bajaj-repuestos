'use client'

import { useState, useEffect } from 'react'
import { buscarEnsambles } from '@/app/(pages)/ensambles/component-actions'
import { formatModels, toModelIds } from '@/lib/modelo'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import type { ActionResult } from '@/lib/action-result'

interface Ensamble {
  id: number
  nameEs: string
  compatibleModels: string
}

interface Props {
  productId: number
  action: (productId: number, formData: FormData) => Promise<ActionResult>
}

export default function AddToAssemblyForm({ productId, action }: Props) {
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<Ensamble[]>([])
  const q = search.trim()
  // Con el término corto no hay resultados: se deriva al renderizar en vez de vaciar el
  // estado desde el efecto.
  const filtered = q.length < 2 ? [] : found

  // Búsqueda de ensambles contra la DB (debounce 250ms); no se cargan todos.
  useEffect(() => {
    if (q.length < 2) return
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await buscarEnsambles(q)
      if (!cancelled) setFound(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  const bound = action.bind(null, productId)

  return (
    <FormConResultado action={bound} className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-3 mt-3">
      <p className="text-sm font-medium text-gray-700">Agregar a un ensamble</p>

      <div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar ensamble por nombre o moto (2+ letras)..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-1"
        />
        <select
          name="ensambleId"
          required
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Seleccionar ensamble...</option>
          {filtered.map(p => (
            <option key={p.id} value={p.id}>
              {p.nameEs} — {formatModels(toModelIds(p.compatibleModels))}
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

      <PendingButton
        className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
      >
        + Agregar a ensamble
      </PendingButton>
    </FormConResultado>
  )
}
