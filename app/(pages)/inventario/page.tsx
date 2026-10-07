import Link from 'next/link'
import { resumenInventario, type FilaInventario } from '@/lib/inventario'
import { formatModels, toModelIds } from '@/lib/modelo'

// Inventario propio pieza por pieza: lo que tengo y lo que viene en cajas confirmadas. Las
// reglas viven en lib/inventario.ts.

const usd = (n: number) => `$${n.toFixed(2)}`

const FILTROS = [
  { value: 'todo', label: 'Todo' },
  { value: 'aqui', label: 'Aquí' },
  { value: 'camino', label: 'En camino' },
] as const
type Filtro = (typeof FILTROS)[number]['value']

interface Props {
  searchParams: Promise<{ q?: string; ver?: string }>
}

export default async function InventarioPage({ searchParams }: Props) {
  const { q = '', ver } = await searchParams
  const filtro: Filtro = FILTROS.some(f => f.value === ver) ? (ver as Filtro) : 'todo'
  const inv = await resumenInventario()

  const termino = q.trim().toLowerCase()
  const pasaFiltro = (f: FilaInventario) =>
    filtro === 'aqui' ? f.aqui !== 0
      : filtro === 'camino' ? f.caminoAereo + f.caminoMaritimo > 0
        : true
  const pasaTexto = (f: FilaInventario) =>
    !termino ||
    f.nameEs.toLowerCase().includes(termino) ||
    (f.bajajCode ?? '').toLowerCase().includes(termino) ||
    (f.compatibleModels ?? '').toLowerCase().includes(termino)

  // Lo que más plata representa arriba.
  const filas = inv.filas
    .filter(f => pasaFiltro(f) && pasaTexto(f))
    .sort((a, b) =>
      (b.valorAquiUsd ?? 0) + b.valorCaminoUsd - ((a.valorAquiUsd ?? 0) + a.valorCaminoUsd) ||
      b.aqui + b.caminoAereo + b.caminoMaritimo - (a.aqui + a.caminoAereo + a.caminoMaritimo) ||
      a.nameEs.localeCompare(b.nameEs),
    )

  const hrefFiltro = (v: Filtro) => {
    const p = new URLSearchParams()
    if (v !== 'todo') p.set('ver', v)
    if (q) p.set('q', q)
    const s = p.toString()
    return s ? `/inventario?${s}` : '/inventario'
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Inventario</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mercancía propia. Cuenta lo que ya llegó y lo que viaja en una caja <span className="font-medium">confirmada</span>;
          un pedido propio fuera de una caja, o en una caja en borrador, todavía no es una compra.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Aquí</p>
          <p className="text-2xl font-bold font-mono text-gray-900">{usd(inv.aqui.valorUsd)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {inv.aqui.unidades} u. · {inv.aqui.productos} productos · a costo de reposición
          </p>
          {inv.aqui.sinCosto > 0 && (
            <p className="text-[11px] text-amber-700">{inv.aqui.sinCosto} sin costo cargado, no están en la suma</p>
          )}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">En camino</p>
          <p className="text-2xl font-bold font-mono text-gray-900">{usd(inv.camino.valorUsd)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {inv.camino.unidades} u.
            {inv.camino.aereo.cajas > 0 && ` · ✈️ ${usd(inv.camino.aereo.valorUsd)} en ${inv.camino.aereo.cajas} caja${inv.camino.aereo.cajas === 1 ? '' : 's'}`}
            {inv.camino.maritimo.cajas > 0 && ` · 🚢 ${usd(inv.camino.maritimo.valorUsd)} en ${inv.camino.maritimo.cajas} embarque${inv.camino.maritimo.cajas === 1 ? '' : 's'}`}
          </p>
          <p className="text-[11px] text-gray-400">puesto en Venezuela: mercancía + flete + cargos</p>
          {inv.camino.incompleto && (
            <p className="text-[11px] text-amber-700">Estimado: a alguna caja le falta el peso real o una factura</p>
          )}
          {inv.sinResolver > 0 && (
            <p className="text-[11px] text-amber-700">
              {inv.sinResolver} pieza{inv.sinResolver === 1 ? '' : 's'} de conjuntos sin identificar en el catálogo
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex gap-1">
          {FILTROS.map(f => (
            <Link
              key={f.value}
              href={hrefFiltro(f.value)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${
                filtro === f.value ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <form action="/inventario" className="flex gap-2">
          {filtro !== 'todo' && <input type="hidden" name="ver" value={filtro} />}
          <input
            name="q"
            defaultValue={q}
            placeholder="Buscar pieza, SKU o moto…"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-64"
          />
        </form>
      </div>

      {filas.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400">
          <p className="text-lg">{inv.filas.length === 0 ? 'No hay mercancía propia ni en camino' : 'Nada con ese filtro'}</p>
          {inv.filas.length === 0 && (
            <p className="text-sm mt-1">
              Lo que metas en una caja y confirmes aparece acá como &quot;en camino&quot;, y pasa a &quot;aquí&quot; cuando lo marcás como llegado.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Pieza</th>
                <th className="text-right px-3 py-2 font-semibold">Aquí</th>
                <th className="text-right px-3 py-2 font-semibold">En camino</th>
                <th className="text-right px-3 py-2 font-semibold">Valor</th>
                <th className="text-left px-4 py-2 font-semibold">Cajas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filas.map(f => {
                const camino = f.caminoAereo + f.caminoMaritimo
                const valor = (f.valorAquiUsd ?? 0) + f.valorCaminoUsd
                const modelos = toModelIds(f.compatibleModels)
                return (
                  <tr key={f.productId} className="hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <Link href={`/products/${f.productId}`} className="font-medium text-gray-900 hover:text-blue-600">
                        {f.nameEs}
                      </Link>
                      <div className="text-[11px] text-gray-400">
                        <span className="font-mono">{f.bajajCode ?? 'sin SKU'}</span>
                        {modelos.length > 0 && <> · {formatModels(modelos)}</>}
                      </div>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${f.aqui > 0 ? 'text-gray-900 font-semibold' : f.aqui < 0 ? 'text-red-600' : 'text-gray-300'}`}>
                      {f.aqui}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${camino > 0 ? 'text-blue-700 font-semibold' : 'text-gray-300'}`}>
                      {camino}
                      {f.caminoAereo > 0 && f.caminoMaritimo > 0 && (
                        <div className="text-[10px] text-gray-400 font-normal">✈️ {f.caminoAereo} · 🚢 {f.caminoMaritimo}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {valor > 0 ? usd(valor) : f.valorAquiUsd == null ? <span className="text-amber-700 text-xs">sin costo</span> : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {f.cajas.map(c => (
                          <Link
                            key={c.envioId}
                            href={`/envios/${c.envioId}`}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 hover:underline"
                          >
                            {c.modo === 'maritimo_cbm' ? '🚢' : '✈️'} {c.nombre} · {c.unidades}
                          </Link>
                        ))}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
