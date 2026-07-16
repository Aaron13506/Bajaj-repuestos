'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { quickUpdateProduct } from '@/app/(pages)/products/actions'

export interface QuickEditValues {
  id: number
  nameEs: string
  nameEn: string | null
  bajajCode: string | null
  compatibleModels: string | null
  priceInr: number | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
  price: number
  priceLocked?: boolean
  stock: number
}

interface Props {
  product: QuickEditValues
  cfg: ConfigMap
  /** Clases del botón disparador (para adaptarlo a la lista o al ensamble) */
  triggerClassName?: string
  triggerLabel?: string
  /** Llamado al guardar con los valores nuevos, para un update optimista en el padre. */
  onOptimistic?: (values: QuickEditValues) => void
  /**
   * Cuántas unidades de esta pieza usa el ensamble desde el que se abrió el editor
   * (ProductComponent.quantity de ese enlace puntual). priceInr/weightGrams SIEMPRE se
   * guardan por unidad; esto es solo para mostrar el total del paquete al lado y evitar
   * cargar por error el total donde va la unidad (o viceversa). Sin ensamble de contexto
   * (ej. lista plana de productos, donde la misma pieza puede repetirse con cantidades
   * distintas en varios ensambles) se omite: no hay un único "total" que mostrar.
   */
  packQty?: number
}

export default function QuickEditProduct({ product, cfg, triggerClassName, triggerLabel = 'Editar', onOptimistic, packQty }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClassName ?? 'text-blue-600 hover:text-blue-800 font-medium'}
      >
        {triggerLabel}
      </button>
      {open && <EditModal product={product} cfg={cfg} onClose={() => setOpen(false)} onOptimistic={onOptimistic} packQty={packQty} />}
    </>
  )
}

function EditModal({ product: d, cfg, onClose, onOptimistic, packQty }: { product: QuickEditValues; cfg: ConfigMap; onClose: () => void; onOptimistic?: (values: QuickEditValues) => void; packQty?: number }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  // Precio fijo: si está activo, la recarga de medidas no pisa este precio.
  const [locked, setLocked] = useState(d.priceLocked ?? false)

  // priceInr/weightGrams se guardan SIEMPRE por unidad; este helper solo muestra el total
  // del paquete que usa el ensamble desde el que se abrió el editor, para no confundir
  // "por unidad" con "total" al cargar el dato (ver prop packQty).
  const hasPack = (packQty ?? 1) > 1
  const [priceInrUnit, setPriceInrUnit] = useState<number | null>(d.priceInr)
  const [weightUnit, setWeightUnit] = useState<number | null>(d.weightGrams)
  const priceInrTotal = hasPack && priceInrUnit != null ? priceInrUnit * packQty! : null
  const weightTotal   = hasPack && weightUnit   != null ? weightUnit   * packQty! : null

  const initialLanded = calcLanded({
    priceInr: d.priceInr, weightGrams: d.weightGrams,
    dimL: d.dimL, dimA: d.dimA, dimH: d.dimH, margin: null,
  }, cfg)?.landedCostUsd ?? null

  const priceInrRef = useRef<HTMLInputElement>(null)
  const weightRef   = useRef<HTMLInputElement>(null)
  const dimLRef     = useRef<HTMLInputElement>(null)
  const dimARef     = useRef<HTMLInputElement>(null)
  const dimHRef     = useRef<HTMLInputElement>(null)
  const landedRef   = useRef<HTMLInputElement>(null)
  const marginRef   = useRef<HTMLInputElement>(null)
  const priceRef    = useRef<HTMLInputElement>(null)

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

  function recalcFromCost() {
    const landed = computeLanded()
    if (landedRef.current) landedRef.current.value = landed != null ? landed.toFixed(2) : ''
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (landed != null && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
    if (hasPack) {
      const priceInr = parseFloat(priceInrRef.current?.value ?? '')
      setPriceInrUnit(!isNaN(priceInr) ? priceInr : null)
      const weight = parseFloat(weightRef.current?.value ?? '')
      setWeightUnit(!isNaN(weight) ? weight : null)
    }
  }

  function recalcFromMargin() {
    const landed = parseFloat(landedRef.current?.value ?? '')
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
  }

  function recalcFromPrice() {
    // Escribir un precio a mano lo marca como fijo (no se pisa al recalcular).
    setLocked(true)
    const landed = parseFloat(landedRef.current?.value ?? '')
    const price  = parseFloat(priceRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(price) && price > 0 && marginRef.current) {
      // Margen con precisión suficiente para que el precio fijo cuadre al recalcular.
      marginRef.current.value = String(+((1 - landed / price) * 100).toFixed(4))
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    const fd = new FormData(e.currentTarget)

    // Update optimista: pintamos los valores nuevos en la fila al instante y
    // cerramos el modal, sin esperar el round-trip a la DB remota.
    const fdStr   = (k: string) => (fd.get(k) as string)?.trim() ?? ''
    const fdInt   = (k: string) => { const v = fdStr(k); return v ? parseInt(v) : null }
    const fdFloat = (k: string) => { const v = fdStr(k); return v ? parseFloat(v) : null }
    onOptimistic?.({
      id:               d.id,
      nameEs:           fdStr('nameEs') || d.nameEs,
      nameEn:           fdStr('nameEn') || null,
      bajajCode:        fdStr('bajajCode') || null,
      compatibleModels: fdStr('compatibleModels') || null,
      priceInr:         fdInt('priceInr'),
      weightGrams:      fdInt('weightGrams'),
      dimL:             fdFloat('dimL'),
      dimA:             fdFloat('dimA'),
      dimH:             fdFloat('dimH'),
      margin:           fdStr('margin') ? parseFloat(fdStr('margin')) / 100 : null,
      price:            parseFloat(fdStr('price')),
      priceLocked:      locked,
      stock:            fdInt('stock') ?? 0,
    })
    onClose()

    await quickUpdateProduct(d.id, fd)
    router.refresh()
  }

  const input = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
  const label = 'block text-xs font-medium text-gray-600 mb-1'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto whitespace-normal" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-8" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Editar producto</h2>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" title="Cerrar">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-6 py-4 space-y-4">
            {/* Nombres */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={label}>Nombre (español) <span className="text-red-500">*</span></label>
                <input name="nameEs" required defaultValue={d.nameEs} className={input} />
              </div>
              <div>
                <label className={label}>Nombre (inglés)</label>
                <input name="nameEn" defaultValue={d.nameEn ?? ''} className={input} />
              </div>
              <div>
                <label className={label}>Código Bajaj</label>
                <input name="bajajCode" defaultValue={d.bajajCode ?? ''} className={`${input} font-mono`} />
              </div>
              <div>
                <label className={label}>Modelos compatibles</label>
                <input name="compatibleModels" defaultValue={d.compatibleModels ?? ''} className={input} />
              </div>
            </div>

            {/* Precios */}
            {hasPack && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Este ensamble usa {packQty} de esta pieza — Precio India y Peso van por unidad.
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className={label}>Precio India (₹)</label>
                <input ref={priceInrRef} name="priceInr" type="number" min="0" step="1"
                  defaultValue={d.priceInr ?? ''} onChange={recalcFromCost} className={input} />
              </div>
              <div>
                <label className={label}>Costo landed</label>
                <input ref={landedRef} name="landedCostUsd" type="number" readOnly tabIndex={-1}
                  defaultValue={initialLanded != null ? initialLanded.toFixed(2) : ''}
                  className="w-full border border-gray-200 bg-gray-50 text-gray-600 rounded-lg px-3 py-2 text-sm cursor-not-allowed" />
              </div>
              <div>
                <label className={label}>Margen (%)</label>
                <input ref={marginRef} name="margin" type="number" min="0" max="99" step="any"
                  defaultValue={d.margin != null ? +(d.margin * 100).toFixed(4) : ''} onChange={recalcFromMargin} className={input} />
              </div>
              <div>
                <label className={label}>Precio venta (USD) <span className="text-red-500">*</span></label>
                <input ref={priceRef} name="price" type="number" min="0" step="0.01" required
                  defaultValue={d.price} onChange={recalcFromPrice} className={input} />
              </div>
            </div>
            {hasPack && (
              <p className="text-xs text-gray-500">
                Unidad: <span className="font-mono text-gray-700">{priceInrUnit != null ? `₹${priceInrUnit}` : '—'}</span>
                {' · '}Paquete ×{packQty}: <span className="font-mono text-gray-700">{priceInrTotal != null ? `₹${priceInrTotal}` : '—'}</span>
              </p>
            )}

            {/* Precio fijo */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="priceLocked"
                value="true"
                checked={locked}
                onChange={(e) => setLocked(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 accent-blue-600"
              />
              <span className="text-xs text-gray-600">
                Precio fijo — no recalcular al cargar medidas/costos (el margen se ajusta solo)
              </span>
            </label>

            {/* Físico */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className={label}>Peso (g)</label>
                <input ref={weightRef} name="weightGrams" type="number" min="0" step="1"
                  defaultValue={d.weightGrams ?? ''} onChange={recalcFromCost} className={input} />
              </div>
              <div>
                <label className={label}>Largo (cm)</label>
                <input ref={dimLRef} name="dimL" type="number" min="0" step="0.1"
                  defaultValue={d.dimL ?? ''} onChange={recalcFromCost} className={input} />
              </div>
              <div>
                <label className={label}>Ancho (cm)</label>
                <input ref={dimARef} name="dimA" type="number" min="0" step="0.1"
                  defaultValue={d.dimA ?? ''} onChange={recalcFromCost} className={input} />
              </div>
              <div>
                <label className={label}>Alto (cm)</label>
                <input ref={dimHRef} name="dimH" type="number" min="0" step="0.1"
                  defaultValue={d.dimH ?? ''} onChange={recalcFromCost} className={input} />
              </div>
              <div>
                <label className={label}>Stock</label>
                <input name="stock" type="number" min="0" defaultValue={d.stock} className={input} />
              </div>
            </div>
            {hasPack && (
              <p className="text-xs text-gray-500">
                Unidad: <span className="font-mono text-gray-700">{weightUnit != null ? `${weightUnit} g` : '—'}</span>
                {' · '}Paquete ×{packQty}: <span className="font-mono text-gray-700">{weightTotal != null ? `${weightTotal} g` : '—'}</span>
              </p>
            )}
            <p className="text-xs text-gray-400">
              El costo landed se calcula solo desde INR + peso. El precio sale del margen (o ajustá el precio y el margen se recalcula).
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100">
            <Link href={`/products/${d.id}/edit`} className="text-xs text-gray-500 hover:text-gray-700">
              Edición completa →
            </Link>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                Cancelar
              </button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 font-medium">
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
