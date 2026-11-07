import { db } from '@/lib/db'
import Link from 'next/link'
import { resumenCobro, type ResumenCobro } from '@/lib/cobro-bcv'
import { margenDePedido, mesDe, nombreMes } from '@/lib/margen'

export const metadata = { title: 'Ventas' }

const usd = (n: number) => `${n < -0.005 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const mes = (m: string) => { const n = nombreMes(m); return n.charAt(0).toUpperCase() + n.slice(1) }
const fecha = (d: Date) =>
  d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Caracas' })

// Las ventas del depósito, aparte de los presupuestos: lo que ya tenía y se vendió en el momento.
// Por dentro son un Pedido tipo 'venta' (lib/venta-stock.ts); acá no se mezclan con los encargos.
export default async function VentasPage({ searchParams }: { searchParams: Promise<{ q?: string; mes?: string; saldo?: string }> }) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ''
  const soloSaldo = sp.saldo === '1'
  const ventas = await db.pedido.findMany({
    where: { tipo: 'venta' },
    include: { items: { select: { salePrice: true, quantity: true, costRealUsd: true, shippingStatusAt: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const filas = ventas.map(v => {
    const lineas = v.items.map(it => ({ salePrice: Number(it.salePrice), quantity: it.quantity }))
    const depositUsd = v.depositUsd != null ? Number(v.depositUsd) : 0
    const cobro = resumenCobro(lineas, depositUsd, v.brechaEscalonPct != null ? Number(v.brechaEscalonPct) : null)
    // El mismo margen que /resultados: el costo de cada línea quedó congelado al vender.
    const margen = margenDePedido(v.items.map(it => ({
      ventaUsd: Number(it.salePrice) * it.quantity,
      costoUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null,
      costoReal: true,
      entregada: true,
      entregadaAt: it.shippingStatusAt,
    })))
    const piezas = v.items.reduce((s, it) => s + it.quantity, 0)
    return { v, cobro, margen, piezas, debe: cobro.saldoBcv > 0.005 }
  })

  // La lista arranca en el mes actual, así las tarjetas de arriba suman lo mismo que la tabla.
  // "todos" la abre a todos los meses; las tarjetas siguen siendo del mes actual.
  const mesActual = mesDe(new Date())
  const meses = [...new Set([mesActual, ...filas.map(f => mesDe(f.v.createdAt))])].sort().reverse()
  const mesSel = sp.mes === 'todos' ? null : sp.mes && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : mesActual
  const mesKpi = mesSel ?? mesActual
  const delMes = filas.filter(f => mesDe(f.v.createdAt) === mesKpi)
  const visibles = filas.filter(f =>
    (!mesSel || mesDe(f.v.createdAt) === mesSel) &&
    (!soloSaldo || f.debe) &&
    (!q || f.v.clientName.toLowerCase().includes(q.toLowerCase()) || String(f.v.id) === q.replace(/^#/, '')))

  const vendidoMes = delMes.reduce((s, f) => s + f.margen.ventaUsd, 0)
  const margenMes = delMes.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0)
  const conPerdida = delMes.filter(f => (f.margen.margenUsd ?? 0) < -0.005)
  const deudoras = filas.filter(f => f.debe)
  const porCobrarBcv = deudoras.reduce((s, f) => s + f.cobro.saldoBcv, 0)
  const porCobrarReal = deudoras.reduce((s, f) => s + f.cobro.saldoReal, 0)

  const href = (p: { q?: string; mes?: string | null; saldo?: boolean }) => {
    const u = new URLSearchParams()
    if (p.q) u.set('q', p.q)
    if (p.mes) u.set('mes', p.mes)
    if (p.saldo) u.set('saldo', '1')
    const s = u.toString()
    return s ? `/ventas?${s}` : '/ventas'
  }
  const filtrado = q !== '' || soloSaldo || mesSel !== mesActual
  const titulo = `${mesSel ? mes(mesSel) : 'Todos los meses'}${soloSaldo ? ', con saldo' : ''}${q ? `, “${q}”` : ''}`

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 text-balance">Ventas</h1>
          <p className="text-sm text-gray-500 mt-1 text-pretty">Lo que vendiste del depósito, en el momento y sin caja.</p>
        </div>
        <Link
          href="/ventas/new"
          className="inline-flex items-center min-h-10 bg-blue-600 text-white px-4 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
        >
          + Nueva venta
        </Link>
      </div>

      {filas.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-500">
          <p className="text-lg">Sin ventas</p>
          <p className="text-sm mt-1">Cuando vendas algo que ya tenés en el depósito, aparece acá.</p>
          <p className="text-sm mt-3">
            <Link href="/ventas/new" className="text-blue-600 hover:underline">Registrar una venta</Link>
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <Link
              href={href({ mes: 'todos', saldo: true })}
              className={`col-span-2 lg:col-span-1 block rounded-xl border p-4 sm:p-5 transition-colors ${
                deudoras.length > 0 ? 'bg-amber-50 border-amber-300 hover:bg-amber-100' : 'bg-white border-gray-200 hover:bg-gray-50'
              }`}
            >
              <p className={`text-xs ${deudoras.length > 0 ? 'text-amber-900' : 'text-gray-500'}`}>Por cobrar · todos los meses</p>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${deudoras.length > 0 ? 'text-amber-900' : 'text-gray-900'}`}>
                {usd(porCobrarBcv)}
              </p>
              <p className={`text-xs mt-1 ${deudoras.length > 0 ? 'text-amber-900 font-medium' : 'text-gray-500'}`}>
                {deudoras.length === 0
                  ? 'Nadie te debe'
                  : <>
                      {deudoras.length} {deudoras.length === 1 ? 'venta' : 'ventas'} con saldo
                      {porCobrarReal < porCobrarBcv - 0.005 && <> · {usd(porCobrarReal)} si pagan en divisas</>}
                      <span className="block mt-0.5 underline underline-offset-2">Ver cuáles →</span>
                    </>}
              </p>
            </Link>
            <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
              <p className="text-xs text-gray-500">Vendido en {nombreMes(mesKpi)}</p>
              <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums">{usd(vendidoMes)}</p>
              <p className="text-xs text-gray-500 mt-1">
                {delMes.length} {delMes.length === 1 ? 'venta' : 'ventas'} · dólares reales
              </p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
              <p className="text-xs text-gray-500">Margen de {nombreMes(mesKpi)}</p>
              <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums">
                {usd(margenMes)}
                {vendidoMes > 0 && (
                  <span className="ml-1.5 text-sm font-medium text-gray-500">{((margenMes / vendidoMes) * 100).toFixed(1)}%</span>
                )}
              </p>
              <p className={`text-xs mt-1 ${conPerdida.length > 0 ? 'text-red-700' : 'text-gray-500'}`}>
                {conPerdida.length > 0
                  ? `${conPerdida.length} ${conPerdida.length === 1 ? 'venta' : 'ventas'} con pérdida (${usd(conPerdida.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0))})`
                  : 'Ninguna con pérdida'}
              </p>
            </div>
          </div>

          <form role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 grow sm:grow-0">
              Buscar
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Cliente o #número…"
                className="h-10 w-full sm:w-60 border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Mes
              <select
                name="mes"
                defaultValue={mesSel ?? 'todos'}
                className="h-10 border border-gray-300 rounded-lg px-2 text-base sm:text-sm text-gray-900 bg-white"
              >
                {meses.map(m => <option key={m} value={m}>{mes(m)}</option>)}
                <option value="todos">Todos los meses</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-2 h-10 text-sm text-gray-700">
              <input type="checkbox" name="saldo" value="1" defaultChecked={soloSaldo} className="size-4 rounded border-gray-300 text-blue-600" />
              Solo con saldo
            </label>
            <button type="submit" className="h-10 px-4 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50">
              Filtrar
            </button>
            {filtrado && (
              <Link href="/ventas" className="inline-flex items-center h-10 px-2 text-sm text-gray-600 hover:text-gray-900 hover:underline">
                Limpiar
              </Link>
            )}
          </form>

          {visibles.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-10 text-center">
              <p className="text-sm text-gray-600 break-words">
                Ninguna venta en {titulo}.
              </p>
              <p className="text-sm mt-2">
                {mesSel ? (
                  <Link href={href({ q, mes: 'todos', saldo: soloSaldo })} className="text-blue-600 hover:underline">Buscar en todos los meses</Link>
                ) : (
                  <Link href="/ventas" className="text-blue-600 hover:underline">Limpiar filtros</Link>
                )}
              </p>
            </div>
          ) : (
            <section aria-labelledby="ventas-lista">
              <h2 id="ventas-lista" className="text-sm font-semibold text-gray-700 mb-2 break-words">
                {titulo} · {visibles.length} {visibles.length === 1 ? 'venta' : 'ventas'}
              </h2>

              {/* Escritorio: tabla, los montos en columna para compararlos. */}
              <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500 whitespace-nowrap">
                    <tr>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Fecha</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">N.º</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Cliente</th>
                      <th scope="col" className="text-right font-medium px-4 py-2.5">Piezas</th>
                      <th scope="col" className="text-right font-medium px-4 py-2.5">Total (BCV)</th>
                      <th scope="col" className="text-right font-medium px-4 py-2.5">Margen</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Cobro</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibles.map(({ v, cobro, margen, piezas }) => (
                      <tr key={v.id} className="align-top hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-gray-600 tabular-nums">{fecha(v.createdAt)}</td>
                        <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-gray-500">#{v.id}</td>
                        <td className="px-4 py-3 min-w-56">
                          <Link href={`/ventas/${v.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline break-words">
                            {v.clientName}
                          </Link>
                          {v.notas && <p className="text-xs text-gray-500 mt-0.5 max-w-md line-clamp-2 break-words text-pretty" title={v.notas}>{v.notas}</p>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-gray-600">{piezas}</td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap">{usd(cobro.totalBcv)}</td>
                        <Margen margenUsd={margen.margenUsd} margenPct={margen.margenPct} className="px-4 py-3 text-right" />
                        <td className="px-4 py-3 whitespace-nowrap"><EstadoCobro cobro={cobro} /></td>
                      </tr>
                    ))}
                  </tbody>
                  {visibles.length > 1 && (
                    <tfoot className="bg-gray-50 border-t border-gray-200 font-semibold text-gray-900">
                      <tr>
                        <th scope="row" colSpan={3} className="text-left px-4 py-2.5">Total</th>
                        <td className="px-4 py-2.5 text-right tabular-nums">{visibles.reduce((s, f) => s + f.piezas, 0)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{usd(visibles.reduce((s, f) => s + f.cobro.totalBcv, 0))}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{usd(visibles.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0))}</td>
                        <td className="px-4 py-2.5 text-xs font-medium text-amber-800 whitespace-nowrap">
                          {visibles.some(f => f.debe) && `${usd(visibles.reduce((s, f) => s + (f.debe ? f.cobro.saldoBcv : 0), 0))} por cobrar`}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              {/* Teléfono: tarjetas, una por venta; todo el nombre es el enlace. */}
              <ul className="md:hidden space-y-2.5">
                {visibles.map(({ v, cobro, margen, piezas }) => (
                  <li key={v.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 tabular-nums">
                        {fecha(v.createdAt)} · <span className="font-mono">#{v.id}</span>
                      </span>
                      <EstadoCobro cobro={cobro} />
                    </div>
                    <Link href={`/ventas/${v.id}`} className="block py-1 text-base font-semibold text-gray-900 break-words">
                      {v.clientName}
                    </Link>
                    {v.notas && <p className="text-sm text-gray-500 break-words text-pretty">{v.notas}</p>}
                    <div className="flex items-baseline justify-between gap-2 border-t border-gray-100 pt-2 tabular-nums">
                      <span className="text-sm text-gray-500">
                        {piezas} {piezas === 1 ? 'pieza' : 'piezas'} · margen{' '}
                        <Margen margenUsd={margen.margenUsd} margenPct={null} as="span" />
                      </span>
                      <span className="text-base font-bold text-gray-900">
                        {usd(cobro.totalBcv)}
                        {cobro.escalonPct != null && <span className="ml-1 text-xs font-semibold text-gray-500">BCV</span>}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500 mt-2 text-pretty">
                Total al dólar BCV, como se le cobra al cliente. Margen en dólares reales, con el costo congelado al vender.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

// El estado del cobro con texto e ícono, no solo color.
function EstadoCobro({ cobro }: { cobro: ResumenCobro }) {
  const [cls, icono, texto] =
    cobro.saldoBcv > 0.005
      ? ['bg-amber-100 text-amber-900', 'M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', `Debe ${usd(cobro.saldoBcv)}`]
      : cobro.saldoBcv < -0.005
        ? ['bg-blue-100 text-blue-900', 'M12 5v14M5 12h14', `A favor ${usd(-cobro.saldoBcv)}`]
        : ['bg-green-100 text-green-800', 'M20 6 9 17l-5-5', 'Pagado']
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums whitespace-nowrap ${cls}`}>
      <svg aria-hidden="true" className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <path d={icono} />
      </svg>
      {texto}
    </span>
  )
}

// Nunca es null: una venta no se guarda sin costo (motivoNoVendible). En rojo si se vendió a pérdida.
function Margen({ margenUsd, margenPct, className = '', as = 'td' }: {
  margenUsd: number | null
  margenPct: number | null
  className?: string
  as?: 'td' | 'span'
}) {
  const Tag = as
  const m = margenUsd ?? 0
  return (
    <Tag className={`tabular-nums whitespace-nowrap ${m < -0.005 ? 'text-red-700 font-semibold' : 'text-gray-700'} ${className}`}>
      {usd(m)}
      {margenPct != null && <span className="ml-1 text-xs font-normal opacity-80">{margenPct.toFixed(0)}%</span>}
    </Tag>
  )
}
