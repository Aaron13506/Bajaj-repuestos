'use client'
import ModelPicker from '@/components/ModelPicker'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { quickUpdateProduct } from '@/app/(pages)/products/actions'
import { ERROR_GENERICO } from '@/components/useEnviarAccion'

export interface QuickEditValues {
  id: number
  nameEs: string
  nameEn: string | null
  bajajCode: string | null
  models: readonly string[]
  priceInr: number | null
  // Override de precio del proveedor activo, EN USD (null/undefined = sin override,
  // cae al precio base priceInr de 99rpm). Solo tiene sentido con un proveedor activo.
  priceUsd?: number | null
  // true = priceUsd ya es el costo landed final (puesto en Venezuela) de ese proveedor,
  // no se le suma Shoppre/seguro/marítimo encima. Solo tiene sentido junto a priceUsd.
  priceIsLanded?: boolean
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
  price: number
  priceLocked?: boolean
  stock: number
  /**
   * Bajaj no la fabrica más: no la consigue ningún proveedor, así que no entra a un embarque
   * ni a un presupuesto. Solo se lee — se marca por lista de SKU en /products/discontinued,
   * porque el dato llega de a decenas (99rpm rotula el despiece entero), no de a una.
   */
  descontinuada?: boolean
}

interface Props {
  product: QuickEditValues
  cfg: ConfigMap
  /** Clases del botón disparador (para adaptarlo a la lista o al ensamble) */
  triggerClassName?: string
  triggerLabel?: string
  /**
   * Llamado al guardar con los valores nuevos, para un update optimista en el padre. Con esta
   * prop el modal se cierra al instante; si el guardado falla se vuelve a llamar con `null`
   * (el padre tiene que soltar el valor que pintó) y se avisa por `onError`.
   */
  onOptimistic?: (values: QuickEditValues | null) => void
  /** Por qué no se guardó, cuando el modal ya se cerró por el camino optimista. */
  onError?: (mensaje: string) => void
  /**
   * Cuántas unidades de esta pieza usa el ensamble desde el que se abrió el editor
   * (EnsambleComponente.quantity de ese enlace puntual). priceInr/weightGrams SIEMPRE se
   * guardan por unidad; esto es solo para mostrar el total del paquete al lado y evitar
   * cargar por error el total donde va la unidad (o viceversa). Sin ensamble de contexto
   * (ej. lista plana de productos, donde la misma pieza puede repetirse con cantidades
   * distintas en varios ensambles) se omite: no hay un único "total" que mostrar.
   */
  packQty?: number
  /**
   * Proveedor activo (selector del sidebar). Si está seteado, el campo Precio India (₹)
   * edita el override de ESE proveedor (SupplierPrice) en vez del precio base de 99rpm.
   */
  activeSupplierId?: number | null
  /**
   * Modo logístico activo. El landed que este editor calcula (y que se guarda, y del que
   * sale el precio de venta) depende de cómo se trae la pieza: por aire pesa el peso, por
   * mar pesa el volumen. Sin esta prop cae a 'aereo', el comportamiento de siempre.
   */
}

export default function QuickEditProduct({ product, cfg, triggerClassName, triggerLabel = 'Editar', onOptimistic, onError, packQty, activeSupplierId }: Props) {
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
      {open && <EditModal product={product} cfg={cfg} onClose={() => setOpen(false)} onOptimistic={onOptimistic} onError={onError} packQty={packQty} activeSupplierId={activeSupplierId} />}
    </>
  )
}

function EditModal({ product: d, cfg, onClose, onOptimistic, onError, packQty, activeSupplierId }: { product: QuickEditValues; cfg: ConfigMap; onClose: () => void; onOptimistic?: (values: QuickEditValues | null) => void; onError?: (mensaje: string) => void; packQty?: number; activeSupplierId?: number | null }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Precio fijo: si está activo, la recarga de medidas no pisa este precio.
  const [locked, setLocked] = useState(d.priceLocked ?? false)

  // Con proveedor activo, el costo de origen se edita en USD (SupplierPrice); sin
  // proveedor, en ₹ (Product.priceInr, base 99rpm) como siempre.
  const isSupplierMode = activeSupplierId != null

  // priceInr/weightGrams se guardan SIEMPRE por unidad; este helper solo muestra el total
  // del paquete que usa el ensamble desde el que se abrió el editor, para no confundir
  // "por unidad" con "total" al cargar el dato (ver prop packQty).
  const hasPack = (packQty ?? 1) > 1
  const [priceInrUnit, setPriceInrUnit] = useState<number | null>(d.priceInr)
  const [priceUsdUnit, setPriceUsdUnit] = useState<number | null>(d.priceUsd ?? null)
  const [weightUnit, setWeightUnit] = useState<number | null>(d.weightGrams)
  const priceInrTotal = hasPack && priceInrUnit != null ? priceInrUnit * packQty! : null
  const priceUsdTotal = hasPack && priceUsdUnit != null ? priceUsdUnit * packQty! : null
  const weightTotal   = hasPack && weightUnit   != null ? weightUnit   * packQty! : null

  const [isLanded, setIsLanded] = useState(d.priceIsLanded ?? false)

  // Con qué cadena se costea lo que se está editando: el precio de 99rpm (₹) es el de la
  // ruta aérea, y el de un proveedor alternativo solo existe por barco — esos proveedores
  // no llegan al mínimo de Shoppre, así que su landed aéreo sería un número inventado.
  const modoCosto = isSupplierMode ? 'maritimo_cbm' : 'aereo'

  const initialLanded = calcLanded({
    priceInr: d.priceInr, priceUsd: d.priceUsd, priceIsLanded: d.priceIsLanded, weightGrams: d.weightGrams,
    dimL: d.dimL, dimA: d.dimA, dimH: d.dimH, margin: null,
  }, cfg, modoCosto)?.landedCostUsd ?? null

  const priceInrRef = useRef<HTMLInputElement>(null)
  const priceUsdRef = useRef<HTMLInputElement>(null)
  const weightRef   = useRef<HTMLInputElement>(null)
  const dimLRef     = useRef<HTMLInputElement>(null)
  const dimARef     = useRef<HTMLInputElement>(null)
  const dimHRef     = useRef<HTMLInputElement>(null)
  const landedRef   = useRef<HTMLInputElement>(null)
  const marginRef   = useRef<HTMLInputElement>(null)
  const priceRef    = useRef<HTMLInputElement>(null)
  // El landed SIN redondear. El campo solo muestra 2 decimales, y calcular margen o precio
  // desde lo que muestra era el error: con landed 2.7349 mostrado como 2.73, escribir un
  // precio de $4 guardaba un margen que después daba $4.01 al recomponer el precio.
  const landedExacto = useRef<number | null>(initialLanded)

  function computeLanded(landedOverride?: boolean): number | null {
    const num = (r: React.RefObject<HTMLInputElement | null>) => {
      const v = parseFloat(r.current?.value ?? '')
      return isNaN(v) ? null : v
    }
    const b = calcLanded({
      priceInr:      isSupplierMode ? null : num(priceInrRef),
      priceUsd:      isSupplierMode ? num(priceUsdRef) : null,
      priceIsLanded: isSupplierMode ? (landedOverride ?? isLanded) : false,
      weightGrams:   num(weightRef),
      dimL:          num(dimLRef),
      dimA:          num(dimARef),
      dimH:          num(dimHRef),
      margin:        null,
    }, cfg, modoCosto)
    return b ? b.landedCostUsd : null
  }

  function recalcFromCost() {
    const landed = computeLanded()
    landedExacto.current = landed
    if (landedRef.current) landedRef.current.value = landed != null ? landed.toFixed(2) : ''
    recalcPriceFromLanded(landed)
  }

  function handleLandedToggle(checked: boolean) {
    setIsLanded(checked)
    const landed = computeLanded(checked)
    landedExacto.current = landed
    if (landedRef.current) landedRef.current.value = landed != null ? landed.toFixed(2) : ''
    recalcPriceFromLanded(landed)
  }

  function recalcPriceFromLanded(landed: number | null) {
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (landed != null && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
    if (hasPack) {
      const priceInr = parseFloat(priceInrRef.current?.value ?? '')
      setPriceInrUnit(!isNaN(priceInr) ? priceInr : null)
      const priceUsd = parseFloat(priceUsdRef.current?.value ?? '')
      setPriceUsdUnit(!isNaN(priceUsd) ? priceUsd : null)
      const weight = parseFloat(weightRef.current?.value ?? '')
      setWeightUnit(!isNaN(weight) ? weight : null)
    }
  }

  function recalcFromMargin() {
    const landed = landedExacto.current ?? NaN
    const margin = parseFloat(marginRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(margin) && margin < 100 && priceRef.current) {
      priceRef.current.value = (landed / (1 - margin / 100)).toFixed(2)
    }
  }

  function recalcFromPrice() {
    // Escribir un precio a mano lo marca como fijo (no se pisa al recalcular).
    setLocked(true)
    const landed = landedExacto.current ?? NaN
    const price  = parseFloat(priceRef.current?.value ?? '')
    if (!isNaN(landed) && !isNaN(price) && price > 0 && marginRef.current) {
      // Margen con precisión de sobra: el precio escrito es el que manda, y el margen es
      // solo su consecuencia — que no se pueda recomponer con unos decimales de más.
      marginRef.current.value = String(+((1 - landed / price) * 100).toFixed(6))
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    const fd = new FormData(e.currentTarget)

    // Update optimista: pintamos los valores nuevos en la fila al instante y
    // cerramos el modal, sin esperar el round-trip a la DB remota. Solo cuando el padre
    // sabe pintar y soltar el valor (`onOptimistic`); sin eso, cerrar antes de guardar
    // dejaba un modal que desaparecía sin decir si había funcionado.
    const fdStr   = (k: string) => (fd.get(k) as string)?.trim() ?? ''
    const fdInt   = (k: string) => { const v = fdStr(k); return v ? parseInt(v) : null }
    const fdFloat = (k: string) => { const v = fdStr(k); return v ? parseFloat(v) : null }
    onOptimistic?.({
      id:               d.id,
      nameEs:           fdStr('nameEs') || d.nameEs,
      nameEn:           fdStr('nameEn') || null,
      bajajCode:        fdStr('bajajCode') || null,
      models:           fd.getAll('models').map(String),
      priceInr:         isSupplierMode ? d.priceInr : fdInt('priceInr'),
      priceUsd:         isSupplierMode ? fdFloat('priceUsd') : (d.priceUsd ?? null),
      priceIsLanded:    isSupplierMode ? isLanded : (d.priceIsLanded ?? false),
      weightGrams:      fdInt('weightGrams'),
      dimL:             fdFloat('dimL'),
      dimA:             fdFloat('dimA'),
      dimH:             fdFloat('dimH'),
      // En modo proveedor el formulario no trae margen ni precio de venta (no se editan
      // desde ahí), así que se conservan los de la pieza.
      margin:           isSupplierMode ? d.margin : (fdStr('margin') ? parseFloat(fdStr('margin')) / 100 : null),
      price:            isSupplierMode ? d.price : parseFloat(fdStr('price')),
      priceLocked:      isSupplierMode ? (d.priceLocked ?? false) : locked,
      stock:            fdInt('stock') ?? 0,
    })
    if (onOptimistic) onClose()

    let motivo: string | null = null
    try {
      const r = await quickUpdateProduct(d.id, activeSupplierId ?? null, fd)
      if (!r.ok) motivo = r.error
    } catch {
      motivo = ERROR_GENERICO
    }

    if (motivo == null) {
      if (!onOptimistic) onClose()
      router.refresh()
      return
    }
    // No se guardó: la fila no puede quedarse mostrando un valor que no existe.
    if (onOptimistic) {
      onOptimistic(null)
      onError?.(motivo)
    } else {
      setError(motivo)
      setSaving(false)
    }
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
              <div className="sm:col-span-2">
                <label className={label}>Motos</label>
                <ModelPicker value={d.models} dense />
              </div>
            </div>

            {/* Precios */}
            {isSupplierMode && (
              <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                Editando el precio para el proveedor activo (en USD) — dejalo vacío para usar el precio base
                de 99rpm{d.priceInr ? ` (₹${d.priceInr})` : ''}.
              </p>
            )}
            {hasPack && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Este ensamble usa {packQty} de esta pieza — {isSupplierMode ? 'Precio proveedor' : 'Precio India'} y Peso van por unidad.
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {isSupplierMode ? (
                <div>
                  <label className={label}>Precio proveedor ($)</label>
                  <input ref={priceUsdRef} name="priceUsd" type="number" min="0" step="0.01"
                    defaultValue={d.priceUsd ?? ''} onChange={recalcFromCost} className={input} />
                  <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      name="priceIsLanded"
                      value="true"
                      checked={isLanded}
                      onChange={(e) => handleLandedToggle(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 accent-blue-600"
                    />
                    <span className="text-[11px] text-gray-500">Ya es costo landed (puesto en Venezuela)</span>
                  </label>
                </div>
              ) : (
                <div>
                  <label className={label}>Precio India (₹)</label>
                  <input ref={priceInrRef} name="priceInr" type="number" min="0" step="1"
                    defaultValue={d.priceInr ?? ''} onChange={recalcFromCost} className={input} />
                </div>
              )}
              <div>
                <label className={label} title={isSupplierMode ? 'Costo puesto en Venezuela por barco con este proveedor. Es solo para comparar: no se guarda en la pieza' : undefined}>
                  {isSupplierMode ? 'Landed 🚢 (referencia)' : 'Costo landed'}
                </label>
                <input ref={landedRef} name="landedCostUsd" type="number" readOnly tabIndex={-1}
                  defaultValue={initialLanded != null ? initialLanded.toFixed(2) : ''}
                  className="w-full border border-gray-200 bg-gray-50 text-gray-600 rounded-lg px-3 py-2 text-sm cursor-not-allowed" />
              </div>
              {!isSupplierMode && (
                <>
                  <div>
                    <label className={label}>Margen (%)</label>
                    <input ref={marginRef} name="margin" type="number" min="0" max="99" step="any"
                      defaultValue={d.margin != null ? +(d.margin * 100).toFixed(6) : ''} onChange={recalcFromMargin} className={input} />
                  </div>
                  <div>
                    <label className={label}>Precio venta (USD) <span className="text-red-500">*</span></label>
                    <input ref={priceRef} name="price" type="number" min="0" step="0.01" required
                      defaultValue={d.price} onChange={recalcFromPrice} className={input} />
                  </div>
                </>
              )}
            </div>
            {isSupplierMode && (
              <p className="text-xs text-gray-500">
                Precio de venta de la pieza: <span className="font-mono text-gray-700">${d.price.toFixed(2)}</span>
                {d.margin != null && <> · margen <span className="font-mono text-gray-700">{+(d.margin * 100).toFixed(1)}%</span></>}
                . Sale del aéreo con 99rpm y no cambia con el precio de un proveedor; se edita sin proveedor seleccionado.
              </p>
            )}
            {hasPack && (
              <p className="text-xs text-gray-500">
                {isSupplierMode ? (
                  <>
                    Unidad: <span className="font-mono text-gray-700">{priceUsdUnit != null ? `$${priceUsdUnit.toFixed(2)}` : '—'}</span>
                    {' · '}Paquete ×{packQty}: <span className="font-mono text-gray-700">{priceUsdTotal != null ? `$${priceUsdTotal.toFixed(2)}` : '—'}</span>
                  </>
                ) : (
                  <>
                    Unidad: <span className="font-mono text-gray-700">{priceInrUnit != null ? `₹${priceInrUnit}` : '—'}</span>
                    {' · '}Paquete ×{packQty}: <span className="font-mono text-gray-700">{priceInrTotal != null ? `₹${priceInrTotal}` : '—'}</span>
                  </>
                )}
              </p>
            )}

            {/* Precio fijo */}
            {!isSupplierMode && (
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
            )}

            {/* Físico */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className={label} title="Peso del bulto: la pieza con su empaque, como se despacha">Peso bulto (g)</label>
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
                <input type="hidden" name="stockCargado" value={d.stock} />
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
              {isSupplierMode
                ? 'Peso y medidas son de la pieza, no del proveedor: si los cambiás se recalcula su costo y su precio de venta por el aéreo.'
                : 'El costo landed se calcula solo desde INR + peso. El precio sale del margen (o ajustá el precio y el margen se recalcula).'}
            </p>
          </div>

          {error && (
            <p role="alert" className="px-6 pb-3 text-xs text-red-600">{error}</p>
          )}

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
