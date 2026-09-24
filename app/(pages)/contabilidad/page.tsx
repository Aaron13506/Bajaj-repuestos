import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import MovimientoForm from '@/components/MovimientoForm'
import AperturaCajaForm from '@/components/AperturaCajaForm'
import { crearMovimiento, eliminarMovimiento, guardarAperturaCaja } from './actions'
import {
  saldoCaja,
  valorInventario,
  cuentasPorPagar,
  listarMovimientos,
  itemsSinCostoReal,
  aperturaCaja,
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  CATEGORIA_LABELS,
  type RangoFechas,
} from '@/lib/movimientos'
import { toConfigMap } from '@/lib/config'
import { VENTA_STATUS, pedidoTotal } from '@/lib/clientes'
import { METODOS_PAGO_INGRESO, METODOS_PAGO_EGRESO } from '@/lib/pagos'

const usd = (n: number) => `$${n.toFixed(2)}`
const fechaCorta = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })
// Fin de día EXCLUSIVO para el filtro "hasta": el input <input type=date> da la fecha a
// las 00:00, y sin este +1 día el propio día elegido quedaría afuera del rango.
const finDiaExclusivo = (s: string) => {
  const d = new Date(`${s}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d
}

interface Props {
  searchParams: Promise<{ desde?: string; hasta?: string }>
}

export default async function ContabilidadPage({ searchParams }: Props) {
  const [cfgRows, inventario, porPagar, pendientesCosto, pedidosConfirmados, envios, suppliers] =
    await Promise.all([
      db.config.findMany(),
      valorInventario(),
      cuentasPorPagar(),
      itemsSinCostoReal(),
      db.pedido.findMany({
        where: { status: VENTA_STATUS, tipo: { not: 'propio' } },
        select: {
          id: true,
          clientName: true,
          depositUsd: true,
          items: { select: { salePrice: true, quantity: true } },
        },
        orderBy: { id: 'desc' },
      }),
      // Todos los envíos, no solo los confirmados: un egreso (adelanto de mercancía, flete
      // reservado) puede ocurrir mientras la caja todavía se está armando (`borrador`) —
      // ese gasto ya salió de la cuenta, aunque la caja como tal no haya cerrado.
      db.envio.findMany({
        select: { id: true, nombre: true, estado: true },
        orderBy: { id: 'desc' },
        take: 50,
      }),
      db.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ])

  const apertura = aperturaCaja(toConfigMap(cfgRows))

  // Filtro de fechas del libro: puramente de lectura, sobre Movimiento — nada nuevo que
  // persistir para "separar por períodos". El saldo de caja (rangoCaja) es independiente
  // de este filtro: es siempre el corrido completo desde la apertura, nunca lo que se esté
  // mirando en la tabla de abajo.
  const sp = await searchParams
  const filtroDesde = sp.desde?.trim() || null
  const filtroHasta = sp.hasta?.trim() || null
  const hayFiltro = filtroDesde != null || filtroHasta != null

  const rangoLibro: RangoFechas | undefined = hayFiltro
    ? {
        desde: filtroDesde ? new Date(`${filtroDesde}T00:00:00`) : new Date(0),
        hasta: filtroHasta ? finDiaExclusivo(filtroHasta) : null,
      }
    : undefined
  const rangoCaja: RangoFechas | undefined = apertura ? { desde: apertura.desde, hasta: null } : undefined

  const [caja, movimientos] = await Promise.all([
    saldoCaja(rangoCaja),
    listarMovimientos(50, rangoLibro),
  ])
  const saldoTotal = (apertura?.saldoInicial ?? 0) + caja.saldo

  // Cuentas por cobrar: mismo cálculo que clienteTotales/cobranzaEnvio (total del pedido
  // menos depositUsd), pero mirando TODOS los pedidos confirmados a la vez, no uno por caja.
  const porCobrar = pedidosConfirmados
    .map(p => {
      const total = pedidoTotal(p.items)
      const recibido = p.depositUsd != null ? parseFloat(p.depositUsd.toString()) : 0
      return { pedidoId: p.id, clientName: p.clientName, total, recibido, falta: total - recibido }
    })
    .filter(p => p.falta > 0.01)
    .sort((a, b) => b.falta - a.falta)

  const totalPorCobrar = porCobrar.reduce((s, p) => s + p.falta, 0)
  const totalPorPagar = porPagar.reduce((s, e) => s + Math.max(0, e.pendiente), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Contabilidad</h1>
        <Link
          href="/contabilidad/comprar"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Registrar compra
        </Link>
      </div>

      {pendientesCosto.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 text-sm text-amber-800 flex items-center justify-between">
          <span>
            <strong>{pendientesCosto.length}</strong> {pendientesCosto.length === 1 ? 'ítem' : 'ítems'} de pedidos
            confirmados sin costo real cargado todavía — a medida que vayas comprando, registralo
            acá para que quede en el libro.
          </span>
          <Link href="/contabilidad/comprar" className="font-semibold underline shrink-0 ml-3">
            Cargar
          </Link>
        </div>
      )}

      {/* Tarjetas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-400">Saldo de caja</p>
            <AperturaCajaForm
              action={guardarAperturaCaja}
              actual={apertura ? { desde: apertura.desde.toISOString().slice(0, 10), saldoInicial: apertura.saldoInicial } : null}
            />
          </div>
          <p className={`text-2xl font-bold font-mono ${saldoTotal >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
            {usd(saldoTotal)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">
            {apertura
              ? `${usd(apertura.saldoInicial)} apertura (${fechaCorta(apertura.desde)}) + ${usd(caja.ingresos)} ingresos − ${usd(caja.egresos)} egresos`
              : `${usd(caja.ingresos)} ingresos − ${usd(caja.egresos)} egresos`}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Valor de inventario</p>
          <p className="text-2xl font-bold font-mono text-gray-900">{usd(inventario.valorUsd)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            {inventario.productos} productos con stock
            {inventario.sinCosto > 0 && ` — ${inventario.sinCosto} sin costo cargado, no están en la suma`}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Por cobrar</p>
          <p className="text-2xl font-bold font-mono text-amber-700">{usd(totalPorCobrar)}</p>
          <p className="text-[11px] text-gray-400 mt-1">{porCobrar.length} pedidos con saldo</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Por pagar</p>
          <p className="text-2xl font-bold font-mono text-amber-700">{usd(totalPorPagar)}</p>
          <p className="text-[11px] text-gray-400 mt-1">{porPagar.length} cajas con pendiente</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Cuentas por cobrar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-5 py-3 border-b border-gray-100">
            Cuentas por cobrar
          </h2>
          {porCobrar.length === 0 ? (
            <p className="text-sm text-gray-400 px-5 py-6">Nada pendiente de cobrar.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-50">
                {porCobrar.map(p => (
                  <tr key={p.pedidoId}>
                    <td className="px-5 py-2.5">
                      <Link href={`/presupuestos/${p.pedidoId}`} className="text-blue-600 hover:underline">
                        {p.clientName}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-amber-700">{usd(p.falta)}</td>
                    <td className="px-5 py-2.5 text-right text-xs text-gray-400">de {usd(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Cuentas por pagar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-5 py-3 border-b border-gray-100">
            Cuentas por pagar
          </h2>
          {porPagar.length === 0 ? (
            <p className="text-sm text-gray-400 px-5 py-6">Nada pendiente de pagar.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-50">
                {porPagar.map(e => (
                  <tr key={e.envioId}>
                    <td className="px-5 py-2.5">
                      <Link href={`/envios/${e.envioId}`} className="text-blue-600 hover:underline">
                        {e.nombre ?? `Envío #${e.envioId}`}
                      </Link>
                      <span className="text-xs text-gray-400 ml-1">· {e.supplierName}</span>
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-amber-700">{usd(Math.max(0, e.pendiente))}</td>
                    <td className="px-5 py-2.5 text-right text-xs text-gray-400">
                      {e.itemsSinCosto > 0 ? `${e.itemsSinCosto} sin costo real` : `de ${usd(e.debido)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Nuevo movimiento */}
      <MovimientoForm
        action={crearMovimiento}
        categoriasIngreso={CATEGORIAS_INGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] }))}
        categoriasEgreso={CATEGORIAS_EGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] }))}
        metodosIngreso={METODOS_PAGO_INGRESO}
        metodosEgreso={METODOS_PAGO_EGRESO}
        pedidos={pedidosConfirmados.map(p => ({ id: p.id, clientName: p.clientName }))}
        envios={envios}
        suppliers={suppliers}
      />

      {/* Libro de movimientos */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Libro de movimientos
          </h2>
          {/* Separar por períodos: un filtro de fecha de lectura, sin nada que persistir
              aparte — se pega directo sobre Movimiento.fecha (ver rangoLibro arriba). */}
          <form className="flex items-end gap-2">
            <div>
              <label className="block text-[10px] text-gray-400 mb-0.5">Desde</label>
              <input
                type="date" name="desde" defaultValue={filtroDesde ?? ''}
                className="border border-gray-300 rounded-lg px-2 py-1 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 mb-0.5">Hasta</label>
              <input
                type="date" name="hasta" defaultValue={filtroHasta ?? ''}
                className="border border-gray-300 rounded-lg px-2 py-1 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <button type="submit" className="px-3 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Filtrar
            </button>
            {hayFiltro && (
              <Link href="/contabilidad" className="text-xs text-blue-600 hover:underline px-1 pb-1.5">
                Ver todo
              </Link>
            )}
          </form>
        </div>
        {movimientos.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6">
            {hayFiltro ? 'Nada en ese rango de fechas.' : 'Todavía no hay movimientos cargados.'}
          </p>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Fecha</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Categoría</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Nota</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Referencia</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Monto</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {movimientos.map(m => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-gray-500">{m.fecha.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-2">{CATEGORIA_LABELS[m.categoria as keyof typeof CATEGORIA_LABELS] ?? m.categoria}</td>
                  <td className="px-4 py-2 text-gray-500">{m.descripcion ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {m.pedido && <Link href={`/presupuestos/${m.pedido.id}`} className="text-blue-600 hover:underline">{m.pedido.clientName}</Link>}
                    {m.envio && <Link href={`/envios/${m.envio.id}`} className="text-blue-600 hover:underline">{m.envio.nombre ?? `Envío #${m.envio.id}`}</Link>}
                    {!m.pedido && !m.envio && (m.supplier?.name ?? '—')}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono font-semibold ${m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'}`}>
                    {m.tipo === 'ingreso' ? '+' : '−'}{usd(m.monto)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DeleteButton
                      action={eliminarMovimiento.bind(null, m.id)}
                      confirmMessage="¿Eliminar este movimiento del libro?"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
