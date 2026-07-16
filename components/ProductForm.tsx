'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { calcLanded, type ConfigMap } from '@/lib/calc'

interface Group {
  id: number
  nameEs: string
  bajajCode: string | null
}

interface ProductFormValues {
  isAssembly?: boolean
  bajajCode?: string | null
  sourceUrl?: string | null
  nameEs?: string
  nameEn?: string | null
  description?: string | null
  notes?: string | null
  compatibleModels?: string | null
  weightGrams?: number | null
  dimL?: number | null
  dimA?: number | null
  dimH?: number | null
  priceInr?: number | null
  landedCostUsd?: number | null
  margin?: number | null
  price?: number | string
  priceLocked?: boolean
  stock?: number
}

interface Props {
  action: (formData: FormData) => Promise<void>
  groups?: Group[]
  defaultValues?: ProductFormValues
  submitLabel: string
  cfg?: ConfigMap
}

export default function ProductForm({ action, groups = [], defaultValues: d = {}, submitLabel, cfg = {} }: Props) {
  const priceInrRef = useRef<HTMLInputElement>(null)
  const weightRef   = useRef<HTMLInputElement>(null)
  const dimLRef     = useRef<HTMLInputElement>(null)
  const dimARef     = useRef<HTMLInputElement>(null)
  const dimHRef     = useRef<HTMLInputElement>(null)
  const landedRef   = useRef<HTMLInputElement>(null)
  const marginRef   = useRef<HTMLInputElement>(null)
  const priceRef    = useRef<HTMLInputElement>(null)
  const lockRef     = useRef<HTMLInputElement>(null)
  const [groupSearch, setGroupSearch] = useState('')

  // Costo landed calculado en vivo desde INR + peso + dims + config (mismo
  // cálculo que el catálogo). Devuelve null si falta INR o peso.
  function computeLanded(): number | null {
    const num = (r: React.RefObject<HTMLInputElement | null>) => {
      const v = parseFloat(r.current?.value ?? '')
      return isNaN(v) ? null : v
    }
    const b = calcLanded({
      priceInr:    num(priceInrRef),
      weightGrams: num(weightRef),
      dimL:        num(dimLRef),
      dimA:        num(dimARef),
      dimH:        num(dimHRef),
      margin:      null,
    }, cfg)
    return b ? b.landedCostUsd : null
  }

  // Cambió un insumo de costo (INR/peso/dims): recalcula landed y, con el
  // margen vigente, deriva el precio.
  function recalcFromCost() {
    const landed = computeLanded()
    if (landedRef.current) landedRef.current.value = landed != null ? landed.toFixed(2) : ''
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (landed != null && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
  }

  // Cambió el margen → recalcula el precio.
  function recalcFromMargin() {
    const landed = parseFloat(landedRef.current?.value ?? '')
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
  }

  // Cambió el precio manualmente → recalcula el margen y lo marca como fijo.
  function recalcFromPrice() {
    if (lockRef.current) lockRef.current.checked = true
    const landed = parseFloat(landedRef.current?.value ?? '')
    const price  = parseFloat(priceRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(price) && price > 0 && marginRef.current) {
      // Margen con precisión suficiente para que el precio fijo cuadre al recalcular.
      marginRef.current.value = String(+((1 - landed / price) * 100).toFixed(4))
    }
  }

  const filteredGroups = groupSearch.length > 0
    ? groups.filter(g =>
        g.nameEs.toLowerCase().includes(groupSearch.toLowerCase()) ||
        g.bajajCode?.toLowerCase().includes(groupSearch.toLowerCase())
      )
    : groups

  return (
    <form action={action} className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">

      {/* Tipo */}
      <section>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" name="isAssembly" value="true" defaultChecked={d.isAssembly ?? false}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
          <div>
            <span className="text-sm font-medium text-gray-900">Es un ensamble / grupo</span>
            <p className="text-xs text-gray-500">Marcá esto si es un conjunto de piezas (ej: Rear Brake Pedal, Crankcase LH)</p>
          </div>
        </label>
      </section>

      {/* Identificación */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Identificación</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre (español) <span className="text-red-500">*</span></label>
            <input name="nameEs" required defaultValue={d.nameEs ?? ''} placeholder="Ej: Pedal de freno trasero"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Se usa en presupuestos</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre (inglés)</label>
            <input name="nameEn" defaultValue={d.nameEn ?? ''} placeholder="Ej: Rear Brake Pedal"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Referencia interna / catálogo Bajaj</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Código Bajaj</label>
            <input name="bajajCode" defaultValue={d.bajajCode ?? ''} placeholder="Ej: JR161036"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Modelos compatibles</label>
            <input name="compatibleModels" defaultValue={d.compatibleModels ?? ''} placeholder="Ej: Pulsar N250/N160"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">URL fuente (99rpm / Boodmo)</label>
            <input name="sourceUrl" type="url" defaultValue={d.sourceUrl ?? ''} placeholder="https://..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
        </div>
      </section>

      {/* Asignar a grupo */}
      {groups.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Asignar a un ensamble</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Ensamble padre</label>
              <input
                value={groupSearch}
                onChange={e => setGroupSearch(e.target.value)}
                placeholder="Filtrar ensambles..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-1"
              />
              <select name="parentId"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Sin ensamble padre</option>
                {filteredGroups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.bajajCode ? `[${g.bajajCode}] ` : ''}{g.nameEs}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sub-grupo</label>
              <input name="parentGroupName" placeholder="Ej: Fasteners, Spring..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              <p className="text-xs text-gray-400 mt-1">El grupo dentro del ensamble</p>
            </div>
          </div>
        </section>
      )}

      {/* Descripción */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Descripción</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
            <textarea name="description" rows={2} defaultValue={d.description ?? ''}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notas / variantes</label>
            <textarea name="notes" rows={2} defaultValue={d.notes ?? ''} placeholder="Variantes, observaciones..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none" />
          </div>
        </div>
      </section>

      {/* Precios */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Precios</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Precio India (₹)</label>
            <input ref={priceInrRef} name="priceInr" type="number" min="0" step="1" defaultValue={d.priceInr ?? ''}
              onChange={recalcFromCost}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Costo landed (USD)</label>
            <input ref={landedRef} name="landedCostUsd" type="number" min="0" step="0.01" readOnly tabIndex={-1}
              defaultValue={d.landedCostUsd ?? ''}
              className="w-full border border-gray-200 bg-gray-50 text-gray-600 rounded-lg px-3 py-2 text-sm cursor-not-allowed" />
            <p className="text-xs text-gray-400 mt-1">Auto: INR + envío + seguro</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Margen (%)</label>
            <input ref={marginRef} name="margin" type="number" min="0" max="99" step="any"
              defaultValue={d.margin != null ? +(d.margin * 100).toFixed(4) : ''} onChange={recalcFromMargin}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Precio venta (USD) <span className="text-red-500">*</span></label>
            <input ref={priceRef} name="price" type="number" min="0" step="0.01" required
              defaultValue={d.price != null ? parseFloat(d.price.toString()) : ''} onChange={recalcFromPrice}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
        </div>
        <label className="flex items-center gap-2 mt-3 cursor-pointer">
          <input ref={lockRef} type="checkbox" name="priceLocked" value="true" defaultChecked={d.priceLocked ?? false}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 accent-blue-600 focus:ring-blue-500" />
          <span className="text-xs text-gray-600">
            Precio fijo — no recalcular al cargar medidas/costos (el margen se ajusta solo)
          </span>
        </label>
        <p className="text-xs text-gray-400 mt-2">
          El precio se calcula solo desde el costo y el margen. Podés sobrescribir el margen o el precio y el otro se ajusta.
        </p>
      </section>

      {/* Físico */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Medidas y stock</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Peso real (g)</label>
            <input ref={weightRef} name="weightGrams" type="number" min="0" step="1" defaultValue={d.weightGrams ?? ''}
              onChange={recalcFromCost}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Largo (cm)</label>
            <input ref={dimLRef} name="dimL" type="number" min="0" step="0.1" defaultValue={d.dimL ?? ''}
              onChange={recalcFromCost}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ancho (cm)</label>
            <input ref={dimARef} name="dimA" type="number" min="0" step="0.1" defaultValue={d.dimA ?? ''}
              onChange={recalcFromCost}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Alto (cm)</label>
            <input ref={dimHRef} name="dimH" type="number" min="0" step="0.1" defaultValue={d.dimH ?? ''}
              onChange={recalcFromCost}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Stock</label>
            <input name="stock" type="number" min="0" defaultValue={d.stock ?? 0}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
        </div>
      </section>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
        <Link href="/products" className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
          Cancelar
        </Link>
        <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
