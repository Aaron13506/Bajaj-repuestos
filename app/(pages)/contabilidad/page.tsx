import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import MovimientoForm from '@/components/MovimientoForm'
import AperturaCajaForm from '@/components/AperturaCajaForm'
import ConversionForm from '@/components/ConversionForm'
import { crearMovimiento, crearConversion, eliminarMovimiento, guardarAperturaCaja } from './actions'
import {
  saldoCaja,
  saldosPorCuenta,
  valorBsEnLibro,
  listarMovimientos,
  itemsSinCostoReal,
  aperturaCaja,
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  CATEGORIA_LABELS,
  type RangoFechas,
} from '@/lib/movimientos'
import { toConfigMap, num } from '@/lib/config'
import { CUENTA_LABELS } from '@/lib/cuentas'
import { resumenInventario } from '@/lib/inventario'
import { gastosPorVenir } from '@/lib/costo-envios'
import { VENTA_STATUS, pedidoTotal } from '@/lib/clientes'
import { METODOS_PAGO_INGRESO, METODOS_PAGO_EGRESO } from '@/lib/pagos'
import { SITUACION_LABELS, situacionDeCobro, type SituacionCobro } from '@/lib/saldo-entrega'

const usd = (n: number) => `$${n.toFixed(2)}`
const ORDEN_SITUACION: Record<SituacionCobro, number> = { entregado: 0, parcial: 1, en_transito: 2 }
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
  const [cfgRows, inventario, porVenir, pendientesCosto, pedidosConfirmados, envios, suppliers] =
    await Promise.all([
      db.config.findMany(),
      resumenInventario(),
      gastosPorVenir(),
      itemsSinCostoReal(),
      db.pedido.findMany({
        where: { status: VENTA_STATUS, tipo: { not: 'propio' } },
        select: {
          id: true,
          clientName: true,
          depositUsd: true,
          items: { select: { salePrice: true, quantity: true, shippingStatus: true } },
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

  const cfg = toConfigMap(cfgRows)
  const [caja, porCuenta, valorBs, movimientos] = await Promise.all([
    saldoCaja(rangoCaja),
    saldosPorCuenta(rangoCaja),
    valorBsEnLibro(),
    listarMovimientos(50, rangoLibro),
  ])
  const saldoTotal = (apertura?.saldoInicial ?? 0) + caja.saldo

  // Cuentas por cobrar: mismo cálculo que clienteTotales/cobranzaEnvio (total del pedido
  // menos depositUsd), pero mirando TODOS los pedidos confirmados a la vez, no uno por caja.
  const porCobrar = pedidosConfirmados
    .map(p => {
      const total = pedidoTotal(p.items)
      const recibido = p.depositUsd != null ? parseFloat(p.depositUsd.toString()) : 0
      // Lo que ya se entregó y no se pagó es el riesgo; lo que todavía viaja es lo normal de un pedido
      // por encargo, con su saldo contra entrega. No es lo mismo y no se mezclan (ver saldo-entrega).
      return { pedidoId: p.id, clientName: p.clientName, total, recibido, falta: total - recibido, situacion: situacionDeCobro(p.items) }
    })
    .filter(p => p.falta > 0.01)
    // Lo entregado sin pagar primero, y dentro de cada grupo lo más grande.
    .sort((a, b) => ORDEN_SITUACION[a.situacion] - ORDEN_SITUACION[b.situacion] || b.falta - a.falta)

  const totalPorCobrar = porCobrar.reduce((s, p) => s + p.falta, 0)
  const totalPorSituacion = (sit: SituacionCobro) => porCobrar.filter(p => p.situacion === sit).reduce((s, p) => s + p.falta, 0)
  const sinPagarEntregado = totalPorSituacion('entregado') + totalPorSituacion('parcial')
  const sobrepagadas = porVenir.sobrepagadas
  const totalPorVenir = porVenir.cajas.reduce((s, g) => s + g.totalUsd, 0)

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
              actual={apertura ? { desde: apertura.desde.toISOString().slice(0, 10), saldoInicial: apertura.saldoInicial, cuenta: apertura.cuenta } : null}
            />
          </div>
          <p className={`text-2xl font-bold font-mono ${saldoTotal >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
            {usd(saldoTotal)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">
            {apertura
              ? `${usd(apertura.saldoInicial)} apertura (${fechaCorta(apertura.desde)}) + ${usd(caja.ingresos)} ingresos − ${usd(caja.egresos)} egresos`
              : `${usd(caja.ingresos)} ingresos − ${usd(caja.egresos)} egresos`}
            {Math.abs(caja.costoConversion) >= 0.005 && (caja.costoConversion > 0
              ? ` − ${usd(caja.costoConversion)} que costó convertir a USDT`
              : ` + ${usd(-caja.costoConversion)} ganados al convertir a USDT`)}
          </p>
          {/* Dónde está: lo que suman las cuentas, más la apertura, es el saldo de arriba. */}
          <ul className="mt-2 pt-2 border-t border-gray-100 space-y-0.5">
            {porCuenta.map(c => ({ ...c, usd: c.usd + (apertura && c.cuenta === apertura.cuenta ? apertura.saldoInicial : 0) })).map(c => (
              <li key={c.cuenta ?? 'sin'} className="flex justify-between text-[11px] text-gray-500">
                <span>{c.cuenta ? CUENTA_LABELS[c.cuenta] : 'Sin cuenta'}</span>
                <span className="font-mono">
                  {usd(c.usd)}
                  {c.bs != null && Math.abs(c.bs) >= 0.5 && (
                    <span className="text-gray-400">
                      {' '}· Bs {c.bs.toLocaleString('es-VE', { maximumFractionDigits: 0 })}{c.sinBs > 0 ? '+' : ''}
                    </span>
                  )}
                </span>
              </li>
            ))}
            {apertura && !apertura.cuenta && (
              <li className="flex justify-between text-[11px] text-gray-400">
                <span>Apertura</span>
                <span className="font-mono">{usd(apertura.saldoInicial)}</span>
              </li>
            )}
          </ul>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-400">Valor de inventario</p>
            <Link href="/inventario" className="text-[11px] text-blue-600 hover:underline">ver piezas</Link>
          </div>
          <p className="text-2xl font-bold font-mono text-gray-900">
            {usd(inventario.aqui.valorUsd + inventario.camino.valorUsd)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">
            {usd(inventario.aqui.valorUsd)} aquí ({inventario.aqui.productos} productos)
            {' + '}{usd(inventario.camino.valorUsd)} en camino
          </p>
          {inventario.camino.unidades > 0 && (
            <p className="text-[11px] text-gray-400">
              en camino: {inventario.camino.unidades} u. en{' '}
              {inventario.camino.aereo.cajas + inventario.camino.maritimo.cajas} caja{inventario.camino.aereo.cajas + inventario.camino.maritimo.cajas === 1 ? '' : 's'} confirmada{inventario.camino.aereo.cajas + inventario.camino.maritimo.cajas === 1 ? '' : 's'}
              {inventario.camino.incompleto && ' · estimado, faltan datos de alguna caja'}
            </p>
          )}
          {inventario.aqui.sinCosto > 0 && (
            <p className="text-[11px] text-gray-400">
              {inventario.aqui.sinCosto} sin costo cargado, no están en la suma
            </p>
          )}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Por cobrar</p>
          <p className="text-2xl font-bold font-mono text-amber-700">{usd(totalPorCobrar)}</p>
          <p className="text-[11px] text-gray-400 mt-1">{porCobrar.length} pedidos con saldo</p>
          {sinPagarEntregado > 0.005 && (
            <p className="text-[11px] text-red-600 font-semibold mt-0.5">
              {usd(sinPagarEntregado)} ya entregado sin pagar
            </p>
          )}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs text-gray-400 mb-1">Gastos por venir</p>
          <p className="text-2xl font-bold font-mono text-amber-700">{usd(totalPorVenir)}</p>
          <p className="text-[11px] text-gray-400 mt-1">
            flete y proveedor de {porVenir.cajas.length} caja{porVenir.cajas.length === 1 ? '' : 's'} en curso
            {sobrepagadas.length > 0 && (
              <span className="text-red-600"> · {sobrepagadas.length} sobrepagada{sobrepagadas.length === 1 ? '' : 's'}</span>
            )}
          </p>
          {/* El mínimo a guardar: lo que queda del saldo si sale todo lo comprometido. */}
          <p className={`text-[11px] font-semibold mt-0.5 ${saldoTotal - totalPorVenir >= 0 ? 'text-gray-600' : 'text-red-600'}`}>
            libre: {usd(saldoTotal - totalPorVenir)}
          </p>
        </div>
      </div>

      {/* El detalle de cobrar y de lo comprometido, plegado: lo principal de la página es el libro. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6 items-start">
        <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Por cobrar <span className="normal-case font-normal text-gray-400">· {porCobrar.length} pedidos · {usd(totalPorCobrar)}</span>
          </summary>
          {porCobrar.length === 0 ? (
            <p className="text-sm text-gray-400 px-5 py-4 border-t border-gray-100">Nada pendiente de cobrar.</p>
          ) : (
            <table className="w-full text-sm border-t border-gray-100">
              <tbody className="divide-y divide-gray-50">
                {porCobrar.map(p => (
                  <tr key={p.pedidoId} className={p.situacion === 'entregado' ? 'bg-red-50/50' : undefined}>
                    <td className="px-5 py-2">
                      <Link href={`/presupuestos/${p.pedidoId}`} className="text-blue-600 hover:underline">
                        {p.clientName}
                      </Link>
                      <span className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        p.situacion === 'entregado' ? 'bg-red-100 text-red-700'
                          : p.situacion === 'parcial' ? 'bg-amber-100 text-amber-800'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {SITUACION_LABELS[p.situacion]}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-amber-700">{usd(p.falta)}</td>
                    <td className="px-5 py-2 text-right text-xs text-gray-400">de {usd(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>

        <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Gastos por venir <span className="normal-case font-normal text-gray-400">· {porVenir.cajas.length} cajas · {usd(totalPorVenir)}</span>
          </summary>
          {porVenir.cajas.length === 0 ? (
            <p className="text-sm text-gray-400 px-5 py-4 border-t border-gray-100">Ninguna caja en curso con gastos pendientes.</p>
          ) : (
            <table className="w-full text-sm border-t border-gray-100">
              <tbody className="divide-y divide-gray-50">
                {porVenir.cajas.map(g => (
                  <tr key={g.envioId}>
                    <td className="px-5 py-2">
                      <Link href={`/envios/${g.envioId}`} className="text-blue-600 hover:underline">
                        {g.nombre ?? `Envío #${g.envioId}`}
                      </Link>
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-amber-700">
                      {g.incompleto && <span className="text-gray-400" title="Estimado de piso: faltan pesos, medidas o costos">≥ </span>}
                      {usd(g.totalUsd)}
                    </td>
                    <td className="px-5 py-2 text-right text-xs text-gray-400">
                      {[g.fletePorPagarUsd > 0.005 && `flete ${usd(g.fletePorPagarUsd)} ${g.fleteEstimado ? 'estimado' : 'facturado'}`, g.proveedorPorPagarUsd > 0.005 && `proveedor ${usd(g.proveedorPorPagarUsd)}`].filter(Boolean).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* Pagado de más: no es "cero por pagar", es plata que salió y no figura debida.
              Puede ser un pago repetido, un costo real mal cargado o un flete anotado como
              pago al proveedor. Se muestra aparte para que no desaparezca del listado. */}
          {sobrepagadas.length > 0 && (
            <div className="border-t border-red-100 bg-red-50/40">
              <p className="text-xs font-semibold text-red-700 px-5 pt-3">Pagado de más al proveedor</p>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-red-50">
                  {sobrepagadas.map(e => (
                    <tr key={e.envioId}>
                      <td className="px-5 py-2">
                        <Link href={`/envios/${e.envioId}`} className="text-blue-600 hover:underline">
                          {e.nombre ?? `Envío #${e.envioId}`}
                        </Link>
                        <span className="text-xs text-gray-400 ml-1">· {e.supplierName}</span>
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-red-700">+{usd(-e.pendiente)}</td>
                      <td className="px-5 py-2 text-right text-xs text-gray-400">
                        {usd(e.pagado)} pagado de {usd(e.debido)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </div>

      {/* Nuevo movimiento */}
      <MovimientoForm
        action={crearMovimiento}
        categoriasIngreso={CATEGORIAS_INGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] }))}
        categoriasEgreso={CATEGORIAS_EGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] }))}
        metodosIngreso={METODOS_PAGO_INGRESO}
        // Pagar en Bs solo desde acá: a un proveedor de afuera no se le paga en bolívares.
        metodosEgreso={[...METODOS_PAGO_EGRESO, METODOS_PAGO_INGRESO[0]]}
        pedidos={pedidosConfirmados.map(p => ({ id: p.id, clientName: p.clientName }))}
        envios={envios}
        suppliers={suppliers}
        tasaBsSugerida={num(cfg, 'bsd_usd_rate', 0)}
        tasaBcvSugerida={num(cfg, 'bcv_usd_rate', 0)}
        // Un egreso en Bs sale a lo que valen en el libro (costo promedio), como una conversión.
        tasaLibroBs={valorBs ? 1 / valorBs : num(cfg, 'bsd_usd_rate', 0)}
      />

      <ConversionForm action={crearConversion} valor={valorBs} />

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
                <th className="text-left px-4 py-2 font-medium text-gray-500">Cuenta</th>
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
                  <td className="px-4 py-2 text-gray-500">{m.cuenta ? CUENTA_LABELS[m.cuenta as keyof typeof CUENTA_LABELS] ?? m.cuenta : '—'}</td>
                  <td className="px-4 py-2 text-gray-500">{m.descripcion ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {m.pedido && <Link href={`/presupuestos/${m.pedido.id}`} className="text-blue-600 hover:underline">{m.pedido.clientName}</Link>}
                    {m.envio && <Link href={`/envios/${m.envio.id}`} className="text-blue-600 hover:underline">{m.envio.nombre ?? `Envío #${m.envio.id}`}</Link>}
                    {!m.pedido && !m.envio && (m.supplier?.name ?? '—')}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono font-semibold ${m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'}`}>
                    {m.tipo === 'ingreso' ? '+' : '−'}{usd(m.monto)}
                    {m.montoBs != null && (
                      <span className="block text-[10px] font-normal text-gray-400">
                        Bs {m.montoBs.toLocaleString('es-VE', { maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DeleteButton
                      action={eliminarMovimiento.bind(null, m.id)}
                      confirmMessage={m.grupo ? 'Es una conversión: se borran las dos patas (la salida en Bs y la entrada a USDT). ¿Seguir?' : '¿Eliminar este movimiento del libro?'}
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
