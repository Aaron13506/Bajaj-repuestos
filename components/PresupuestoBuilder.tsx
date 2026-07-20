'use client'

import { useState, useMemo, useEffect } from 'react'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import { getAssemblyComponents, searchProducts } from '@/app/(pages)/presupuestos/builder-actions'

interface Product {
  id: number
  nameEs: string
  bajajCode: string | null
  price: number
  imageUrl?: string | null
  compatibleModels?: string | null
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
}

export default function PresupuestoBuilder({
  assemblies,
  models,
  action,
  initialClientName = '',
  initialNotas = '',
  initialItems = [],
  tipo = 'cliente',
}: Props) {
  const isPropio = tipo === 'propio'
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [cart, setCart] = useState<CartItem[]>(initialItems)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [modelFilter, setModelFilter] = useState('')
  const [asmSearch, setAsmSearch] = useState('')
  const [clientName, setClientName] = useState(initialClientName)
  const [notas, setNotas] = useState(initialNotas)
  const [submitting, setSubmitting] = useState(false)

  // Componentes cargados on-demand por ensamble (cache en memoria).
  const [compCache, setCompCache] = useState<Record<number, AssemblyComponent[]>>({})
  const [loadingComps, setLoadingComps] = useState(false)

  // Ensambles filtrados por moto + texto, para que la lista no sea inmanejable.
  const filteredAssemblies = useMemo(() => {
    const q = asmSearch.trim().toLowerCase()
    return assemblies.filter(a => {
      if (modelFilter && (a.compatibleModels ?? '') !== modelFilter) return false
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
      if (!checked[comp.id]) continue
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
      if (!checked[comp.id]) continue
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

  function updateCartPrice(productId: number, price: number) {
    if (isNaN(price) || price < 0) return
    setCart(prev => prev.map(c => c.productId === productId ? { ...c, unitPrice: price } : c))
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
    setCart(prev => [
      ...prev,
      { productId: product.id, nameEs: product.nameEs, bajajCode: product.bajajCode, unitPrice: product.price, quantity: 1, imageUrl: product.imageUrl },
    ])
    setSearch('')
  }

  const total = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!clientName.trim() || cart.length === 0 || submitting) return
    setSubmitting(true)
    const fd = new FormData()
    fd.set('clientName', clientName)
    fd.set('notas', notas)
    fd.set('tipo', tipo)
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
                          return (
                            <label
                              key={comp.id}
                              className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer ${alreadyInCart ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked[comp.id]}
                                disabled={alreadyInCart}
                                onChange={e =>
                                  setChecked(prev => ({ ...prev, [comp.id]: e.target.checked }))
                                }
                                className="w-4 h-4 rounded border-gray-300 text-blue-600 shrink-0"
                              />
                              <span className="flex-1 min-w-0">
                                <span className="text-sm text-gray-900">{comp.child.nameEs}</span>
                                {comp.child.bajajCode && (
                                  <span className="ml-2 text-xs font-mono text-gray-400">
                                    {comp.child.bajajCode}
                                  </span>
                                )}
                                {alreadyInCart && (
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
                                disabled={!checked[comp.id] || alreadyInCart}
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
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
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
                        <p className="text-sm font-medium text-gray-900 truncate">{p.nameEs}</p>
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
              </>
            )}
          </div>

          {/* Client info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
            <h2 className="font-semibold text-gray-900">{isPropio ? 'Referencia' : 'Datos del cliente'}</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isPropio ? 'Etiqueta / referencia' : 'Nombre'} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                placeholder={isPropio ? 'Ej: Stock reventa julio' : 'Nombre del cliente'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                required
              />
            </div>

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
              disabled={!clientName.trim() || cart.length === 0 || submitting}
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
