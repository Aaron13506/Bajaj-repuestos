'use client'

import { useEffect, useState } from 'react'
import { shortModel, type MotoModelInfo } from '@/lib/modelo'

interface Props {
  basePath: string          // '/groups' o '/products'
  models: readonly MotoModelInfo[]  // las 15 motos (el valor del filtro es el id del enum)
  categories: string[]      // categorías ya scopeadas al modelo actual
  current: { model: string; category: string; search: string; lowStock?: boolean }
  showLowStock?: boolean
  searchPlaceholder?: string
  /** Proveedores para comparar la columna 🚢. Solo lo pasa /products. */
  suppliers?: { id: number; name: string }[]
  currentSupplierId?: number | null
}

export default function CatalogFilters({
  basePath,
  models,
  categories,
  current,
  showLowStock = false,
  searchPlaceholder = 'Buscar por nombre o código...',
  suppliers,
  currentSupplierId = null,
}: Props) {
  // Filtrar es una navegación del NAVEGADOR, no del router de React.
  //
  // Antes era `router.push()` dentro de un `useTransition`, y cuando la transición no
  // confirmaba —la respuesta del servidor llegaba entera y aun así el árbol nunca se
  // aplicaba— el `pending` quedaba en true para siempre: el botón clavado en
  // "Filtrando…", el listado viejo en pantalla y el `<select>` rebotado a "Todos los
  // modelos", sin más salida que recargar a mano. La transición tampoco compraba nada:
  // estas dos páginas se renderizan enteras en el servidor, así que la navegación cuesta
  // lo mismo por los dos caminos, solo que una se puede colgar y la otra no.
  const [enviando, setEnviando] = useState(false)

  // Volver con el botón atrás restaura la página desde el bfcache tal como quedó, con el
  // "Filtrando…" congelado. `pageshow` es el único evento que dispara en ese caso.
  useEffect(() => {
    const reset = () => setEnviando(false)
    window.addEventListener('pageshow', reset)
    return () => window.removeEventListener('pageshow', reset)
  }, [])

  // Navega con lo que el formulario tiene puesto. Los campos vacíos se caen de la URL, y
  // `page` no es un campo, así que la paginación se resetea sola al cambiar un filtro.
  function enviar(form: HTMLFormElement, limpiarCategoria = false) {
    const datos = new FormData(form)
    if (limpiarCategoria) datos.set('category', '')
    const p = new URLSearchParams()
    for (const [clave, valor] of datos.entries()) {
      const texto = String(valor).trim()
      if (texto) p.set(clave, texto)
    }
    const qs = p.toString()
    setEnviando(true)
    window.location.assign(qs ? `${basePath}?${qs}` : basePath)
  }

  const hasFilters = !!(current.model || current.category || current.search || current.lowStock)

  return (
    // `method`/`action` son el camino sin JS: si el handler no corre, el navegador manda
    // el formulario igual y la pantalla filtra (con la URL algo más sucia).
    <form
      method="GET"
      action={basePath}
      onSubmit={(e) => { e.preventDefault(); enviar(e.currentTarget) }}
      className={`flex flex-wrap items-center gap-3 mb-6 transition-opacity ${enviando ? 'opacity-60' : ''}`}
    >
      {/* Modelo — al cambiar, navega y limpia la categoría (que era la del modelo viejo).
          No controlado a propósito: controlarlo contra el prop del servidor hacía que el
          desplegable volviera solo al valor viejo mientras cargaba. */}
      <select
        name="model"
        defaultValue={current.model}
        onChange={(e) => enviar(e.currentTarget.form!, true)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
      >
        <option value="">Todos los modelos</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{shortModel(m.id)}</option>
        ))}
      </select>

      {/* Categoría — scopeada al modelo actual */}
      <input
        name="category"
        defaultValue={current.category}
        list="catalog-categories"
        placeholder={current.model ? 'Categoría de este modelo...' : 'Categoría (Swing Arm...)'}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-56"
      />
      <datalist id="catalog-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <input
        name="search"
        defaultValue={current.search}
        placeholder={searchPlaceholder}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-64"
      />

      {showLowStock && (
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            name="lowStock"
            value="1"
            defaultChecked={!!current.lowStock}
            onChange={(e) => enviar(e.currentTarget.form!)}
          />
          Solo stock bajo
        </label>
      )}

      {/* Contra quién comparar la columna 🚢. Es un filtro de la vista y nada más: el
          proveedor con el que se compra de verdad lo elige cada embarque. */}
      {suppliers && suppliers.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          🚢 comparar contra
          <select
            name="proveedor"
            defaultValue={currentSupplierId ?? ''}
            onChange={(e) => enviar(e.currentTarget.form!)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">99rpm (base)</option>
            {suppliers.map(sp => (
              <option key={sp.id} value={sp.id}>{sp.name}</option>
            ))}
          </select>
        </label>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-900 transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {enviando ? 'Filtrando…' : 'Filtrar'}
      </button>
      {hasFilters && (
        <a href={basePath} className="text-sm text-gray-500 hover:text-gray-700 self-center">
          Limpiar
        </a>
      )}
      {enviando && (
        <span className="text-sm text-gray-500 self-center animate-pulse">Buscando…</span>
      )}
    </form>
  )
}
