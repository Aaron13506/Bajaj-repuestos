'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setBundlePrice } from '@/app/(pages)/products/[id]/measure-actions'

export default function BundlePriceEditor({
  assemblyId,
  currentPrice,
  priceLocked,
  partsSum,
}: {
  assemblyId: number
  currentPrice: number
  priceLocked: boolean
  partsSum: number
}) {
  const router = useRouter()
  const [price, setPrice] = useState(currentPrice > 0 ? String(currentPrice) : '')
  const [locked, setLocked] = useState(priceLocked)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    const fd = new FormData(e.currentTarget)
    await setBundlePrice(assemblyId, fd)
    setSaving(false)
    router.refresh()
  }

  const num = parseFloat(price)
  const effective = !isNaN(num) && num > 0 && locked ? num : partsSum

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h2 className="font-semibold text-gray-900 mb-1">Precio del conjunto</h2>
      <p className="text-xs text-gray-500 mb-4">
        Precio de venta del ensamble como una unidad. Es el que se usa por defecto al agregarlo
        como <span className="font-medium">conjunto</span> en un presupuesto. Suma de las piezas: <span className="font-mono">${partsSum.toFixed(2)}</span>.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Precio fijo (USD)</label>
          <div className="flex items-center">
            <span className="text-gray-400 mr-1">$</span>
            <input
              name="price"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => { setPrice(e.target.value); if (e.target.value) setLocked(true) }}
              placeholder={partsSum.toFixed(2)}
              className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer pb-2">
          <input
            type="checkbox"
            name="priceLocked"
            value="true"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 accent-blue-600"
          />
          <span className="text-xs text-gray-600">Usar precio fijo</span>
        </label>

        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 font-medium"
        >
          {saving ? 'Guardando...' : 'Guardar'}
        </button>
      </form>

      <p className="mt-3 text-sm text-gray-600">
        Precio del conjunto hoy:{' '}
        <span className="font-semibold text-blue-700">${effective.toFixed(2)}</span>
        {locked && !isNaN(num) && num > 0
          ? <span className="text-xs text-gray-400"> (fijo)</span>
          : <span className="text-xs text-gray-400"> (suma de piezas)</span>}
      </p>
    </div>
  )
}
