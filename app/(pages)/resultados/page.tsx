import Link from 'next/link'
import { cargarCancelaciones, cargarMargenes, resultadosMensuales } from '@/lib/resultados'
import { mesDe, type EstadoMargen } from '@/lib/margen'

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const pct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)
const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })
const nombreMes = (m: string) => {
  const [a, mm] = m.split('-').map(Number)
  return new Date(a, mm - 1, 1).toLocaleDateString('es-VE', { month: 'long', year: 'numeric' })
}

const ESTADOS: Record<EstadoMargen, { label: string; cls: string; ayuda: string }> = {
  realizado: { label: 'Realizado', cls: 'bg-green-100 text-green-700', ayuda: 'Entregado y con el costo que de verdad se pagó (compra, flete y caja facturados).' },
  estimado: { label: 'Estimado', cls: 'bg-blue-100 text-blue-700', ayuda: 'Entregado, pero algún costo (compra, flete o peso de la caja) sigue siendo el de tabla.' },
  sin_costo: { label: 'Sin costo', cls: 'bg-amber-100 text-amber-700', ayuda: 'Entregado y alguna línea no tiene costo (no está en ninguna caja ni tiene el costo real cargado).' },
  en_curso: { label: 'En curso', cls: 'bg-gray-100 text-gray-600', ayuda: 'Todavía falta entregar: el margen es una proyección.' },
}

interface Props {
  searchParams: Promise<{ estado?: string; mes?: string }>
}

export default async function ResultadosPage({ searchParams }: Props) {
  const sp = await searchParams
  const filas = await cargarMargenes()
  const [meses, canceladas] = await Promise.all([resultadosMensuales(filas), cargarCancelaciones()])
  const conPlata = canceladas.filter(c => c.retenidoUsd > 0.005)

  const estadoFiltro = (Object.keys(ESTADOS) as EstadoMargen[]).find(e => e === sp.estado) ?? null
  const mesFiltro = sp.mes && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : null
  const visibles = filas.filter(f =>
    (!estadoFiltro || f.margen.estado === estadoFiltro) &&
    (!mesFiltro || (f.margen.estado !== 'en_curso' && mesDe(f.fecha) === mesFiltro)),
  )

  const mesActual = mesDe(new Date())
  const actual = meses.find(m => m.mes === mesActual)
  const enCurso = filas.filter(f => f.margen.estado === 'en_curso')
  const proyectado = enCurso.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0)
  const enCursoSinCosto = enCurso.filter(f => f.margen.margenUsd == null).length
  const conPerdida = filas.filter(f => f.margen.margenUsd != null && f.margen.margenUsd < 0)

  const href = (q: Record<string, string | null>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `/resultados?${s}` : '/resultados'
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Resultados</h1>
        <p className="text-sm text-gray-500 mt-1">
          Cuánto se ganó de verdad: lo que se vendió contra lo que costó traerlo puesto acá, en dólares reales.
          El margen cuenta cuando se <strong>entrega</strong>, no cuando se cobra.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Resultado de {nombreMes(mesActual)}</p>
          <p className={`text-2xl font-bold font-mono ${(actual?.resultadoUsd ?? 0) >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
            {usd(actual?.resultadoUsd ?? 0)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">margen + lo retenido de cancelados − gastos − costo de convertir Bs</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Margen del mes</p>
          <p className="text-2xl font-bold font-mono text-gray-900">{usd(actual?.margenUsd ?? 0)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {actual ? `${actual.pedidos} pedido${actual.pedidos === 1 ? '' : 's'} entregado${actual.pedidos === 1 ? '' : 's'} · ${pct(actual.margenPct)}` : 'nada entregado este mes'}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Por entregar (proyectado)</p>
          <p className="text-2xl font-bold font-mono text-gray-900">{usd(proyectado)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {enCurso.length} pedido{enCurso.length === 1 ? '' : 's'} en curso
            {enCursoSinCosto > 0 && ` · ${enCursoSinCosto} sin costo, no suman`}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Pedidos con pérdida</p>
          <p className={`text-2xl font-bold font-mono ${conPerdida.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{conPerdida.length}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {conPerdida.length > 0 ? usd(conPerdida.reduce((s, f) => s + (f.margen.margenUsd ?? 0), 0)) + ' en total' : 'ninguno'}
          </p>
        </div>
      </div>

      {/* Por mes */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto mb-8">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-5 py-3 border-b border-gray-100">Por mes</h2>
        {meses.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6">Todavía no hay nada entregado ni gastos anotados.</p>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-100 text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Mes</th>
                <th className="text-right px-4 py-2 font-medium">Pedidos</th>
                <th className="text-right px-4 py-2 font-medium">Vendido</th>
                <th className="text-right px-4 py-2 font-medium">Costo</th>
                <th className="text-right px-4 py-2 font-medium">Margen</th>
                <th className="text-right px-4 py-2 font-medium">%</th>
                <th className="text-right px-4 py-2 font-medium" title="Lo cobrado de pedidos cancelados que no se devolvió: plata que se quedó el negocio.">Cancelados</th>
                <th className="text-right px-4 py-2 font-medium" title="Gastos operativos y otros egresos. El flete, la comisión del giro y la compra ya están dentro del costo de cada pedido.">Gastos</th>
                <th className="text-right px-4 py-2 font-medium" title="Lo que costó pasar Bs a USDT">Convertir Bs</th>
                <th className="text-right px-4 py-2 font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {meses.map(m => (
                <tr key={m.mes}>
                  <td className="px-4 py-2">
                    <Link href={href({ mes: m.mes })} className="text-blue-600 hover:underline capitalize">{nombreMes(m.mes)}</Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {m.pedidos}
                    {m.pedidosSinCosto > 0 && <span className="text-amber-700" title="Entregados sin costo: no suman al margen"> +{m.pedidosSinCosto}?</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{usd(m.ventaUsd)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{usd(m.costoUsd)}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {usd(m.margenUsd)}
                    {m.margenEstimadoUsd !== 0 && (
                      <span className="block text-[10px] font-normal text-blue-600">{usd(m.margenEstimadoUsd)} estimado</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{pct(m.margenPct)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{m.cancelacionesUsd !== 0 ? usd(m.cancelacionesUsd) : '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{usd(m.gastosUsd)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{usd(m.conversionUsd)}</td>
                  <td className={`px-4 py-2 text-right font-mono font-semibold ${m.resultadoUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>{usd(m.resultadoUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Por pedido */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Por pedido ({visibles.length}{visibles.length !== filas.length ? ` de ${filas.length}` : ''})
          </h2>
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <Link href={href({ mes: mesFiltro })} className={`px-2.5 py-1 rounded-full border ${!estadoFiltro ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>Todos</Link>
            {(Object.keys(ESTADOS) as EstadoMargen[]).map(e => (
              <Link key={e} href={href({ estado: e, mes: mesFiltro })} title={ESTADOS[e].ayuda}
                className={`px-2.5 py-1 rounded-full border ${estadoFiltro === e ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {ESTADOS[e].label}
              </Link>
            ))}
            {mesFiltro && <Link href={href({ estado: estadoFiltro })} className="text-blue-600 hover:underline px-1">Quitar {mesFiltro}</Link>}
          </div>
        </div>
        {visibles.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6">Ningún pedido con ese filtro.</p>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-100 text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Pedido</th>
                <th className="text-left px-4 py-2 font-medium">Estado</th>
                <th className="text-left px-4 py-2 font-medium">Fecha</th>
                <th className="text-right px-4 py-2 font-medium">Vendido</th>
                <th className="text-right px-4 py-2 font-medium">Costo</th>
                <th className="text-right px-4 py-2 font-medium">Margen</th>
                <th className="text-right px-4 py-2 font-medium">%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visibles.slice(0, 300).map(f => {
                const m = f.margen
                const malo = m.margenUsd != null && m.margenUsd < 0
                return (
                  <tr key={f.pedidoId}>
                    <td className="px-4 py-2">
                      <Link href={`/presupuestos/${f.pedidoId}`} className="text-blue-600 hover:underline">#{f.pedidoId} {f.clientName}</Link>
                      {f.tipo === 'venta' && <span className="ml-2 text-[10px] text-gray-400">depósito</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span title={ESTADOS[m.estado].ayuda} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ESTADOS[m.estado].cls}`}>{ESTADOS[m.estado].label}</span>
                    </td>
                    <td className="px-4 py-2 text-gray-500">{m.entregadoAt ? fecha(m.entregadoAt) : '—'}</td>
                    <td className="px-4 py-2 text-right font-mono">{usd(m.ventaUsd)}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-500">
                      {usd(m.costoUsd)}{m.sinCosto > 0 && <span className="text-amber-700" title={`${m.sinCosto} línea(s) sin costo: es un piso`}> +?</span>}
                      {m.perdidasUsd > 0 && <span className="block text-[10px] text-red-600" title="Pagado por piezas que no se entregaron y se reembolsaron">{usd(m.perdidasUsd)} perdido</span>}
                      {Math.abs(m.brechaUsd) >= 0.01 && <span className={`block text-[10px] ${m.brechaUsd > 0 ? 'text-red-600' : 'text-green-700'}`} title="Lo que la brecha movió entre lo acreditado al cliente y lo que valían sus Bs al cobrar">{m.brechaUsd > 0 ? `${usd(m.brechaUsd)} brecha` : `+${usd(-m.brechaUsd)} brecha`}</span>}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono font-semibold ${m.margenUsd == null ? 'text-gray-400' : malo ? 'text-red-700' : 'text-gray-900'}`}>
                      {m.margenUsd == null ? '—' : usd(m.margenUsd)}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${malo ? 'text-red-700' : m.margenPct != null && m.margenPct < 15 ? 'text-amber-700' : 'text-gray-600'}`}>{pct(m.margenPct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Cancelados: la plata que dejaron. Lo comprado de un pedido cancelado pasó a stock propio, así que acá solo cuenta lo cobrado que se quedó. */}
      {conPlata.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto mt-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-5 py-3 border-b border-gray-100">
            Pedidos cancelados que dejaron plata ({conPlata.length})
          </h2>
          <table className="w-full text-sm whitespace-nowrap">
            <tbody className="divide-y divide-gray-50">
              {conPlata.map(c => (
                <tr key={c.pedidoId}>
                  <td className="px-4 py-2">
                    <Link href={`/presupuestos/${c.pedidoId}`} className="text-blue-600 hover:underline">#{c.pedidoId} {c.clientName}</Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{fecha(c.fecha)}</td>
                  <td className="px-4 py-2 text-gray-500 max-w-md truncate" title={c.motivo ?? undefined}>{c.motivo ?? ''}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-green-700">{usd(c.retenidoUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
