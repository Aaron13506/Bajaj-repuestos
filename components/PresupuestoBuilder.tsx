'use client'

import { useState, useMemo, useEffect } from 'react'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import { sirveParaModelo } from '@/lib/modelos'
import {
  getAssemblyComponents,
  searchProducts,
  costearCarrito,
  type CostoCarrito,
} from '@/app/(pages)/presupuestos/builder-actions'

interface Product {
  id: number
  nameEs: string
  bajajCode: string | null
  price: number
  imageUrl?: string | null
  compatibleModels?: string | null
  /**
   * Bajaj no la fabrica más: no la consigue ningún proveedor. Cotizarla sería prometer una
   * pieza que no se va a poder comprar — y el negocio es por encargo, con seña cobrada, así
   * que la promesa ya tiene plata del cliente adentro. Por eso no se puede agregar.
   */
  descontinuada?: boolean
}

interface AssemblyComponent {
  id: number
  groupName: string
  quantity: number
  child: Product
}

// Header de ensamble (sin componentes — se cargan on-demand al seleccionarlo).
interface Assembly {
  id: number
  nameEs: string
  bajajCode: string | null
  price: number
  imageUrl?: string | null
  compatibleModels: string | null
}

interface CartItem {
  productId: number
  nameEs: string
  bajajCode: string | null
  unitPrice: number
  quantity: number
  imageUrl?: string | null
  /** Si está presente, la línea es un conjunto a precio único y estas son las piezas incluidas. */
  bundleItems?: BundlePiece[]
  /**
   * El precio lo fijó una persona a mano (o viene de un presupuesto ya emitido). Las líneas
   * sin tocar siguen automáticamente al precio sugerido por el costo landed; las tocadas
   * no se pisan nunca — un precio ya conversado con el cliente no puede moverse solo.
   */
  touched?: boolean
}

interface ClienteOption {
  id: number
  nombre: string
  telefono: string | null
}

interface Props {
  assemblies: Assembly[]
  models: string[]
  action: (formData: FormData) => Promise<void>
  initialClientName?: string
  initialNotas?: string
  initialItems?: CartItem[]
  /** 'cliente' = presupuesto para un cliente; 'propio' = stock que traigo para revender. */
  tipo?: 'cliente' | 'propio'
  /** Clientes existentes para elegir (solo aplica cuando tipo === 'cliente'). */
  clientes?: ClienteOption[]
  initialClienteId?: number | null
  /** 'plan' = se armó desde el planificador y hay que volver ahí al guardar. */
  volver?: string
}

export default function PresupuestoBuilder({
  assemblies,
  models,
  action,
  initialClientName = '',
  initialNotas = '',
  initialItems = [],
  tipo = 'cliente',
  clientes = [],
  initialClienteId = null,
  volver,
}: Props) {
  const isPropio = tipo === 'propio'
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  // Lo que ya estaba en el presupuesto entra como precio fijado: son precios que ya se
  // cotizaron, y recalcularlos solos cambiaría un número que el cliente ya vio.
  const [cart, setCart] = useState<CartItem[]>(() => initialItems.map(i => ({ ...i, touched: true })))
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [modelFilter, setModelFilter] = useState('')
  const [asmSearch, setAsmSearch] = useState('')
  const [clientName, setClientName] = useState(initialClientName)
  const [clienteId, setClienteId] = useState(initialClienteId != null ? String(initialClienteId) : '')
  const [nuevoNombre, setNuevoNombre] = useState('')
  const [nuevoTelefono, setNuevoTelefono] = useState('')
  const [notas, setNotas] = useState(initialNotas)
  const [submitting, setSubmitting] = useState(false)

  // Componentes cargados on-demand por ensamble (cache en memoria).
  const [compCache, setCompCache] = useState<Record<number, AssemblyComponent[]>>({})
  const [loadingComps, setLoadingComps] = useState(false)

  // Ensambles filtrados por moto + texto, para que la lista no sea inmanejable.
  const filteredAssemblies = useMemo(() => {
    const q = asmSearch.trim().toLowerCase()
    return assemblies.filter(a => {
      if (modelFilter && !sirveParaModelo(a.compatibleModels, modelFilter)) return false
      return !(q && !(a.nameEs.toLowerCase().includes(q) || a.bajajCode?.toLowerCase().includes(q)));

    })
  }, [assemblies, modelFilter, asmSearch])

  const selectedAssembly = assemblies.find(a => a.id === selectedAssemblyId) ?? null
  const selectedComponents = selectedAssemblyId != null ? compCache[selectedAssemblyId] : undefined

  // Selecciona un ensamble y trae sus componentes de la DB si aún no están en cache.
  async function selectAssembly(id: number | null) {
    setSelectedAssemblyId(id)
    setChecked({})
    setQuantities({})
    if (id != null && !compCache[id]) {
      setLoadingComps(true)
      try {
        const comps = await getAssemblyComponents(id)
        setCompCache(prev => ({ ...prev, [id]: comps }))
      } finally {
        setLoadingComps(false)
      }
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, AssemblyComponent[]>()
    for (const comp of selectedComponents ?? []) {
      const key = comp.groupName || '—'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(comp)
    }
    return map
  }, [selectedComponents])

  function addSelectedToCart() {
    if (!selectedAssembly) return
    // Una misma pieza puede estar marcada en varios subgrupos: sumamos cantidades por pieza.
    const byChild = new Map<number, { comp: AssemblyComponent; qty: number }>()
    for (const comp of selectedComponents ?? []) {
      // El checkbox de una descontinuada está deshabilitado, pero puede haberse marcado
      // como tal mientras tenías el ensamble abierto: el filtro va acá, que es por donde
      // pasa todo lo que entra al carrito.
      if (!checked[comp.id] || comp.child.descontinuada) continue
      const qty = quantities[comp.id] ?? comp.quantity
      const existing = byChild.get(comp.child.id)
      if (existing) existing.qty += qty
      else byChild.set(comp.child.id, { comp, qty })
    }
    if (byChild.size === 0) return
    setCart(prev => {
      const next = [...prev]
      for (const { comp, qty } of byChild.values()) {
        const idx = next.findIndex(c => c.productId === comp.child.id)
        if (idx >= 0) {
          next[idx] = { ...next[idx], quantity: next[idx].quantity + qty }
        } else {
          next.push({
            productId: comp.child.id,
            nameEs: comp.child.nameEs,
            bajajCode: comp.child.bajajCode,
            unitPrice: comp.child.price,
            quantity: qty,
            imageUrl: comp.child.imageUrl,
          })
        }
      }
      return next
    })
    setChecked({})
    setQuantities({})
  }

  function addSelectedAsBundle() {
    if (!selectedAssembly) return
    // Cada componente marcado es una pieza propia del conjunto, incluso si la misma
    // pieza aparece en dos subgrupos (izquierdo/derecho): se mantienen separadas.
    const pieces: BundlePiece[] = []
    let piecesPriceSum = 0
    for (const comp of selectedComponents ?? []) {
      // Igual que en las piezas sueltas: una descontinuada no entra ni escondida adentro de
      // un conjunto — ahí sería peor, porque el precio único la tapa.
      if (!checked[comp.id] || comp.child.descontinuada) continue
      const qty = quantities[comp.id] ?? comp.quantity
      pieces.push({
        nameEs: comp.child.nameEs,
        bajajCode: comp.child.bajajCode,
        quantity: qty,
        groupName: comp.groupName,
      })
      piecesPriceSum += comp.child.price * qty
    }
    if (pieces.length === 0) return
    if (cart.find(c => c.productId === selectedAssembly.id)) return
    // Precio del conjunto: siempre la suma de las piezas marcadas, no el precio propio
    // del ensamble (se pide al proveedor por SKU de pieza, no por el ensamble como unidad).
    setCart(prev => [
      ...prev,
      {
        productId: selectedAssembly.id,
        nameEs: selectedAssembly.nameEs,
        bajajCode: selectedAssembly.bajajCode,
        unitPrice: piecesPriceSum,
        quantity: 1,
        imageUrl: selectedAssembly.imageUrl,
        bundleItems: pieces,
      },
    ])
    setChecked({})
    setQuantities({})
  }

  function removeFromCart(productId: number) {
    setCart(prev => prev.filter(c => c.productId !== productId))
  }

  function updateCartQty(productId: number, qty: number) {
    if (qty < 1) return
    setCart(prev => prev.map(c => c.productId === productId ? { ...c, quantity: qty } : c))
  }

  // Un precio escrito a mano queda marcado como fijado: a partir de ahí el costeo deja de
  // moverlo, aunque cambie la tarifa o el proveedor.
  function updateCartPrice(productId: number, price: number) {
    if (isNaN(price) || price < 0) return
    setCart(prev => prev.map(c => c.productId === productId ? { ...c, unitPrice: price, touched: true } : c))
  }

  // Cantidad de una pieza puntual dentro de un conjunto (por set; se multiplica ×
  // cantidad del conjunto al mostrar/imprimir/pedir a proveedor).
  function updateBundlePieceQty(productId: number, pieceIndex: number, qty: number) {
    if (qty < 1) return
    setCart(prev => prev.map(c => {
      if (c.productId !== productId || !c.bundleItems) return c
      const bundleItems = c.bundleItems.map((p, i) => i === pieceIndex ? { ...p, quantity: qty } : p)
      return { ...c, bundleItems }
    }))
  }

  function addProductToCart(product: Product) {
    if (cart.find(c => c.productId === product.id)) return
    // No se cotiza lo que no se puede comprar. El botón ya está deshabilitado; esto cubre
    // el caso de que la pieza se marque con la búsqueda abierta.
    if (product.descontinuada) return
    setCart(prev => [
      ...prev,
      { productId: product.id, nameEs: product.nameEs, bajajCode: product.bajajCode, unitPrice: product.price, quantity: 1, imageUrl: product.imageUrl },
    ])
    setSearch('')
  }

  const total = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)

  // ── Costeo en vivo (volumen + landed) ──────────────────────────────────────
  // Se recalcula solo cuando cambia la COMPOSICIÓN del carrito (piezas y cantidades),
  // nunca cuando cambia un precio: el landed no depende del precio de venta, y atarlo
  // al precio metería al costeo en un ciclo consigo mismo.
  const [costo, setCosto] = useState<CostoCarrito | null>(null)
  const [costeando, setCosteando] = useState(false)

  const composicion = useMemo(
    () => JSON.stringify(
      cart.map(c => [c.productId, c.quantity, c.bundleItems?.map(p => [p.bajajCode, p.nameEs, p.quantity]) ?? null]),
    ),
    [cart],
  )

  useEffect(() => {
    const lineas = JSON.parse(composicion) as [number, number, [string | null, string, number][] | null][]
    if (lineas.length === 0) { setCosto(null); return }
    let cancelled = false
    setCosteando(true)
    const t = setTimeout(async () => {
      try {
        const r = await costearCarrito(
          lineas.map(([productId, quantity, piezas]) => ({
            productId,
            quantity,
            salePrice: 0,   // la venta se agrega en el cliente: no hace falta mandarla
            // groupName no entra en la composición serializada porque no afecta al costo
            // (el subgrupo es una etiqueta de presentación); se repone vacío para el tipo.
            bundleItems: piezas?.map(([bajajCode, nameEs, qty]) => ({ bajajCode, nameEs, quantity: qty, groupName: '' })) ?? null,
          })),
        )
        if (!cancelled) setCosto(r)
      } finally {
        if (!cancelled) setCosteando(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [composicion])

  const costoPorLinea = useMemo(
    () => new Map((costo?.lineas ?? []).map(l => [l.productId, l])),
    [costo],
  )

  // Las líneas sin precio fijado siguen al sugerido por el landed: agregar una pieza deja
  // el precio del modelo de costos puesto, sin tener que aplicarlo a mano.
  useEffect(() => {
    if (costoPorLinea.size === 0) return
    setCart(prev => {
      let cambio = false
      const next = prev.map(c => {
        if (c.touched) return c
        const sugerido = costoPorLinea.get(c.productId)?.sugeridoUnitUsd
        if (sugerido == null || Math.abs(sugerido - c.unitPrice) < 0.005) return c
        cambio = true
        return { ...c, unitPrice: +sugerido.toFixed(2) }
      })
      return cambio ? next : prev
    })
  }, [costoPorLinea])

  // Precios sugeridos que difieren de lo cotizado, para poder alinear de un golpe lo que
  // se fijó a mano cuando cambió la tarifa o el proveedor.
  const desalineadas = cart.filter(c => {
    const s = costoPorLinea.get(c.productId)?.sugeridoUnitUsd
    return s != null && Math.abs(s - c.unitPrice) >= 0.01
  })

  function aplicarSugeridos() {
    setCart(prev => prev.map(c => {
      const s = costoPorLinea.get(c.productId)?.sugeridoUnitUsd
      return s != null ? { ...c, unitPrice: +s.toFixed(2), touched: true } : c
    }))
  }

  const landedTotal = cart.reduce(
    (s, c) => s + (costoPorLinea.get(c.productId)?.landedUsd ?? 0), 0,
  )
  const margenTotal = total > 0 ? (total - landedTotal) / total : null

  // Búsqueda de piezas sueltas contra la DB (debounce 250ms), sin traer todo el catálogo.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setSearchResults([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await searchProducts(q)
      if (!cancelled) setSearchResults(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search])

  // Excluir del dropdown lo que ya está en el carrito.
  const filteredProducts = useMemo(
    () => searchResults.filter(p => !cart.find(c => c.productId === p.id)).slice(0, 8),
    [searchResults, cart],
  )

  const anyChecked = Object.values(checked).some(Boolean)
  const assemblyInCart = !!selectedAssembly && !!cart.find(c => c.productId === selectedAssembly.id)
  const isEditing = initialItems.length > 0

  // 'propio' sigue con etiqueta de texto libre; 'cliente' requiere elegir un
  // cliente existente o completar el nombre del nuevo.
  const clienteValid = isPropio
    ? clientName.trim().length > 0
    : clienteId !== '' && (clienteId !== '__new__' || nuevoNombre.trim().length > 0)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!clienteValid || cart.length === 0 || submitting) return
    setSubmitting(true)
    const fd = new FormData()
    if (isPropio) {
      fd.set('clientName', clientName)
    } else {
      fd.set('clienteId', clienteId)
      if (clienteId === '__new__') {
        fd.set('nuevoClienteNombre', nuevoNombre.trim())
        fd.set('nuevoClienteTelefono', nuevoTelefono.trim())
      }
    }
    fd.set('notas', notas)
    fd.set('tipo', tipo)
    if (volver) fd.set('volver', volver)
    fd.set(
      'items',
      JSON.stringify(cart.map(c => ({
        productId: c.productId,
        quantity: c.quantity,
        salePrice: c.unitPrice,
        bundleItems: c.bundleItems ?? null,
      })))
    )
    await action(fd)
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

        {/* ── Left: selectors ── */}
        <div className="space-y-4">

          {/* Assembly browser */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-4">Agregar por ensamble</h2>

            {/* Filtros: moto + buscador, para no listar los ~1400 ensambles planos */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={modelFilter}
                onChange={e => {
                  setModelFilter(e.target.value)
                  setSelectedAssemblyId(null); setChecked({}); setQuantities({})
                }}
              >
                <option value="">— Todas las motos —</option>
                {models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <input
                type="text"
                value={asmSearch}
                onChange={e => setAsmSearch(e.target.value)}
                placeholder="Buscar ensamble por nombre o código..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div className="border border-gray-300 rounded-lg mb-1 max-h-80 overflow-y-auto divide-y divide-gray-50">
              {filteredAssemblies.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">Sin resultados</p>
              ) : (
                filteredAssemblies.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => selectAssembly(a.id === selectedAssemblyId ? null : a.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                      a.id === selectedAssemblyId ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    {a.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.imageUrl}
                        alt={a.nameEs}
                        loading="lazy"
                        className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{a.nameEs}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {a.bajajCode && <span className="font-mono">{a.bajajCode}</span>}
                        {a.bajajCode && a.compatibleModels && ' · '}
                        {a.compatibleModels}
                      </p>
                    </div>
                    <span className="text-sm font-mono text-gray-600 shrink-0">${a.price.toFixed(2)}</span>
                  </button>
                ))
              )}
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {filteredAssemblies.length} ensamble{filteredAssemblies.length === 1 ? '' : 's'}
              {modelFilter || asmSearch ? ' (filtrado)' : ''} de {assemblies.length}.
            </p>

            {selectedAssembly && (
              <>
                {selectedAssembly.imageUrl && (
                  <div className="flex items-center gap-3 mb-3 pb-3 border-b border-gray-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={selectedAssembly.imageUrl}
                      alt={selectedAssembly.nameEs}
                      className="w-16 h-16 object-contain rounded-lg border border-gray-100 bg-white shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{selectedAssembly.nameEs}</p>
                      {selectedAssembly.bajajCode && (
                        <p className="text-xs font-mono text-gray-400">{selectedAssembly.bajajCode}</p>
                      )}
                    </div>
                  </div>
                )}
                {loadingComps && !selectedComponents ? (
                  <p className="text-sm text-gray-400 py-6 text-center">Cargando piezas…</p>
                ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                  {Array.from(groups.entries()).map(([groupName, items]) => (
                    <div key={groupName}>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                        {groupName}
                      </p>
                      <div className="space-y-0.5">
                        {items.map(comp => {
                          const alreadyInCart = !!cart.find(c => c.productId === comp.child.id)
                          const nls = !!comp.child.descontinuada
                          const bloqueada = alreadyInCart || nls
                          return (
                            <label
                              key={comp.id}
                              className={`flex items-center gap-3 py-2 px-2 rounded-lg ${
                                nls ? 'opacity-60 cursor-not-allowed bg-red-50/40'
                                  : alreadyInCart ? 'opacity-40 cursor-not-allowed'
                                  : 'cursor-pointer hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked[comp.id]}
                                disabled={bloqueada}
                                onChange={e =>
                                  setChecked(prev => ({ ...prev, [comp.id]: e.target.checked }))
                                }
                                className="w-4 h-4 rounded border-gray-300 text-blue-600 shrink-0 disabled:cursor-not-allowed"
                              />
                              <span className="flex-1 min-w-0">
                                <span className={`text-sm ${nls ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                                  {comp.child.nameEs}
                                </span>
                                <ChipDescontinuada activo={nls} />
                                {comp.child.bajajCode && (
                                  <span className="ml-2 text-xs font-mono text-gray-400">
                                    {comp.child.bajajCode}
                                  </span>
                                )}
                                {alreadyInCart && !nls && (
                                  <span className="ml-2 text-xs text-blue-500">ya agregado</span>
                                )}
                              </span>
                              <input
                                type="number"
                                min={1}
                                value={quantities[comp.id] ?? comp.quantity}
                                onChange={e =>
                                  setQuantities(prev => ({
                                    ...prev,
                                    [comp.id]: parseInt(e.target.value) || 1,
                                  }))
                                }
                                onClick={e => e.stopPropagation()}
                                disabled={!checked[comp.id] || bloqueada}
                                className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center disabled:opacity-40"
                              />
                              <span className="text-sm text-gray-600 w-16 text-right font-mono">
                                ${comp.child.price.toFixed(2)}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                )}

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={addSelectedAsBundle}
                    disabled={!anyChecked || assemblyInCart}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title={assemblyInCart ? 'Este conjunto ya está en el presupuesto' : 'Una sola línea con precio único'}
                  >
                    Agregar como conjunto
                  </button>
                  <button
                    type="button"
                    onClick={addSelectedToCart}
                    disabled={!anyChecked}
                    className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Cada pieza como línea con su propio precio"
                  >
                    Agregar piezas sueltas
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-400">
                  <span className="font-medium text-gray-500">Conjunto:</span> una línea a precio único (editable, por defecto la suma de las piezas elegidas) con las piezas listadas debajo.
                  {' · '}
                  <span className="font-medium text-gray-500">Piezas sueltas:</span> cada pieza con su propio precio.
                </p>
              </>
            )}
          </div>

          {/* Individual search */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">Agregar pieza individual</h2>
            <div className="relative">
              <input
                type="text"
                placeholder="Buscar por nombre o código (pieza o ensamble)..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {filteredProducts.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg divide-y divide-gray-50 overflow-hidden max-h-96 overflow-y-auto">
                  {filteredProducts.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addProductToCart(p)}
                      disabled={!!p.descontinuada}
                      title={p.descontinuada ? 'Bajaj no la fabrica más: no se le puede comprar a ningún proveedor' : undefined}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-red-50/40 disabled:hover:bg-red-50/40 transition-colors"
                    >
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.imageUrl}
                          alt={p.nameEs}
                          className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          <span className={p.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}>{p.nameEs}</span>
                          <ChipDescontinuada activo={p.descontinuada} />
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {p.bajajCode && <span className="font-mono">{p.bajajCode}</span>}
                          {p.bajajCode && p.compatibleModels && ' · '}
                          {p.compatibleModels}
                        </p>
                      </div>
                      <span className="text-sm font-mono text-gray-600 shrink-0">${p.price.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: cart + client ── */}
        <div className="space-y-4">

          {/* Cart */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="font-semibold text-gray-900 mb-4">
              {isPropio ? (isEditing ? 'Piezas del stock' : 'Stock propio') : (isEditing ? 'Piezas del presupuesto' : 'Presupuesto')}
              {cart.length > 0 && (
                <span className="ml-2 text-xs font-normal text-gray-400">
                  {cart.length} {cart.length === 1 ? 'pieza' : 'piezas'}
                </span>
              )}
            </h2>

            {cart.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-10">
                Seleccioná piezas para agregar al presupuesto
              </p>
            ) : (
              <>
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {cart.map(item => (
                    <div
                      key={item.productId}
                      className="py-2 border-b border-gray-50 last:border-0"
                    >
                      <div className="flex items-center gap-2">
                        {item.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.nameEs}
                            className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {item.nameEs}
                            {item.bundleItems && (
                              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                                Conjunto
                              </span>
                            )}
                          </p>
                          {item.bajajCode && (
                            <p className="text-xs font-mono text-gray-400">{item.bajajCode}</p>
                          )}
                          {/* Costo real de traer esta línea. Es lo que decide si el precio
                              de al lado deja plata o la pierde. */}
                          {(() => {
                            const c = costoPorLinea.get(item.productId)
                            if (!c) return null
                            const venta = item.unitPrice * item.quantity
                            const margen = venta > 0 ? (venta - c.landedUsd) / venta : null
                            const sugeridoUnit = c.sugeridoUnitUsd
                            return (
                              <p className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono text-gray-500">{c.weightKg.toFixed(2)} kg</span>
                                <span className="text-gray-300">·</span>
                                <span className="font-mono text-gray-500">landed ${c.landedUsd.toFixed(2)}</span>
                                {margen != null && (
                                  <>
                                    <span className="text-gray-300">·</span>
                                    <span className={`font-mono font-semibold ${
                                      margen >= 0.25 ? 'text-green-600' : margen >= 0 ? 'text-amber-600' : 'text-red-600'
                                    }`}>
                                      {(margen * 100).toFixed(0)}%
                                    </span>
                                  </>
                                )}
                                {c.sinPeso > 0 && (
                                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                    {c.sinPeso} sin peso
                                  </span>
                                )}
                                {sugeridoUnit != null && Math.abs(sugeridoUnit - item.unitPrice) >= 0.01 && (
                                  <button
                                    type="button"
                                    onClick={() => updateCartPrice(item.productId, +sugeridoUnit.toFixed(2))}
                                    className="text-blue-600 hover:underline"
                                    title="Precio que sale de aplicar el margen sobre el costo landed"
                                  >
                                    usar ${sugeridoUnit.toFixed(2)}
                                  </button>
                                )}
                              </p>
                            )
                          })()}
                        </div>
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={e => updateCartQty(item.productId, parseInt(e.target.value) || 1)}
                          title={item.bundleItems ? 'Cantidad de conjuntos (multiplica cada pieza del desglose)' : undefined}
                          className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center shrink-0"
                        />
                        {item.bundleItems ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <div className="flex items-center">
                              <span className="text-sm text-gray-400">$</span>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={item.unitPrice}
                                onChange={e => updateCartPrice(item.productId, parseFloat(e.target.value))}
                                className="w-20 border border-gray-200 rounded px-2 py-0.5 text-sm text-right font-mono"
                                title="Precio del conjunto (por set)"
                              />
                            </div>
                            {item.quantity > 1 && (
                              <span className="text-sm font-mono text-gray-700 w-16 text-right" title="Subtotal (precio × cantidad de conjuntos)">
                                ${(item.unitPrice * item.quantity).toFixed(2)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm font-mono text-gray-700 w-16 text-right shrink-0">
                            ${(item.unitPrice * item.quantity).toFixed(2)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFromCart(item.productId)}
                          className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                          title="Quitar"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      {item.bundleItems && item.bundleItems.length > 0 && (
                        <div className="mt-1.5 ml-1 pl-3 border-l-2 border-gray-100 space-y-1.5">
                          {groupBundlePieces(item.bundleItems).map(([groupName, pieces]) => (
                            <div key={groupName}>
                              {groupName !== '—' && (
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                  {groupName}
                                </p>
                              )}
                              <ul className="space-y-1">
                                {pieces.map((p) => {
                                  const pieceIndex = item.bundleItems!.indexOf(p)
                                  return (
                                    <li key={pieceIndex} className="flex items-center gap-1.5 text-xs text-gray-500">
                                      <input
                                        type="number"
                                        min={1}
                                        value={p.quantity}
                                        onChange={e =>
                                          updateBundlePieceQty(item.productId, pieceIndex, parseInt(e.target.value) || 1)
                                        }
                                        title="Cantidad de esta pieza por set"
                                        className="w-12 border border-gray-200 rounded px-1 py-0.5 text-xs text-center shrink-0"
                                      />
                                      <span className="truncate">× {p.nameEs}</span>
                                      {p.bajajCode && (
                                        <span className="font-mono text-gray-300 shrink-0">{p.bajajCode}</span>
                                      )}
                                      {item.quantity > 1 && (
                                        <span className="text-gray-300 shrink-0">
                                          → {p.quantity * item.quantity} total
                                        </span>
                                      )}
                                    </li>
                                  )
                                })}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex justify-between items-center pt-3 mt-1 border-t border-gray-200">
                  <span className="font-bold text-gray-900">Total</span>
                  <span className="text-xl font-bold font-mono text-blue-700">${total.toFixed(2)}</span>
                </div>

                {/* Lo que cuesta traer lo cotizado, por la ruta aérea — que es por donde
                    salen los pedidos de cliente. El m³ y el FOB son del carril marítimo
                    (mercancía propia) y no tienen nada que hacer acá. */}
                {costo && (
                  <div className="mt-3 pt-3 border-t border-gray-100 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        ✈️ Costo por la ruta aérea
                        {costeando && <span className="ml-2 font-normal normal-case text-gray-400">calculando…</span>}
                      </h3>
                      {costo.proveedor && (
                        <span className="text-[11px] text-gray-400 font-mono">{costo.proveedor}</span>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-[11px] text-gray-400">Peso</p>
                        <p className="text-base font-bold font-mono text-gray-900">{costo.weightKg.toFixed(2)} kg</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400">Landed</p>
                        <p className="text-base font-bold font-mono text-gray-900">${landedTotal.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400">Margen</p>
                        <p className={`text-base font-bold font-mono ${
                          margenTotal == null ? 'text-gray-400'
                            : margenTotal >= 0.25 ? 'text-green-600'
                            : margenTotal >= 0 ? 'text-amber-600' : 'text-red-600'
                        }`}>
                          {margenTotal != null ? `${(margenTotal * 100).toFixed(1)}%` : '—'}
                        </p>
                        <p className="text-[10px] text-gray-400">ganancia ${(total - landedTotal).toFixed(2)}</p>
                      </div>
                    </div>

                    {costo.sinPeso > 0 && (
                      <p className="text-[11px] bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-2.5 py-2">
                        <span className="font-semibold">{costo.sinPeso} pieza{costo.sinPeso === 1 ? '' : 's'} sin peso.</span>{' '}
                        No entran al costo: el landed real va a ser mayor que el que ves.
                        {isEditing
                          ? ' Cargá las medidas desde la ficha del presupuesto.'
                          : ' Guardá y cargá las medidas desde su ficha, de a un ensamble.'}
                      </p>
                    )}

                    {desalineadas.length > 0 && (
                      <button
                        type="button"
                        onClick={aplicarSugeridos}
                        className="w-full text-xs border border-blue-200 text-blue-700 bg-blue-50 rounded-lg px-3 py-2 hover:bg-blue-100 transition-colors"
                      >
                        Aplicar precios sugeridos a {desalineadas.length}{' '}
                        {desalineadas.length === 1 ? 'línea' : 'líneas'} (margen sobre el landed)
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Client info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
            <h2 className="font-semibold text-gray-900">{isPropio ? 'Referencia' : 'Datos del cliente'}</h2>

            {isPropio ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Etiqueta / referencia <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={clientName}
                  onChange={e => setClientName(e.target.value)}
                  placeholder="Ej: Stock reventa julio"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  required
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cliente <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={clienteId}
                    onChange={e => setClienteId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    required
                  >
                    <option value="">Elegí un cliente…</option>
                    {clientes.map(c => (
                      <option key={c.id} value={c.id}>{c.nombre}</option>
                    ))}
                    <option value="__new__">+ Nuevo cliente</option>
                  </select>
                </div>
                {clienteId === '__new__' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={nuevoNombre}
                      onChange={e => setNuevoNombre(e.target.value)}
                      placeholder="Nombre del cliente"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      required
                    />
                    <input
                      type="text"
                      value={nuevoTelefono}
                      onChange={e => setNuevoTelefono(e.target.value)}
                      placeholder="Teléfono (opcional)"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
              <textarea
                value={notas}
                onChange={e => setNotas(e.target.value)}
                placeholder="Observaciones..."
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={!clienteValid || cart.length === 0 || submitting}
              className="w-full bg-blue-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Guardando...' : isEditing ? 'Guardar cambios' : isPropio ? 'Guardar stock' : 'Guardar presupuesto'}
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}
