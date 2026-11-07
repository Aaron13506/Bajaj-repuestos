import { db } from '@/lib/db'
import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import MovimientoForm from '@/components/MovimientoForm'
import AperturaCajaForm from '@/components/AperturaCajaForm'
import ConversionForm from '@/components/ConversionForm'
import AnotarLibro from '@/components/AnotarLibro'
import PestanasCaja from '@/components/PestanasCaja'
import SeccionCaja from '@/components/SeccionCaja'
import { crearMovimiento, crearConversion, eliminarMovimiento, guardarAperturaCaja } from './actions'
import {
  saldoCaja,
  saldosPorCuenta,
  valorBsEnLibro,
  listarMovimientos,
  leerFiltroLibro,
  itemsSinCostoReal,
  aperturaCaja,
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  CATEGORIA_LABELS,
  type RangoFechas,
  type MovimientoRow,
} from '@/lib/movimientos'
import { toConfigMap, num } from '@/lib/config'
import { CUENTAS, CUENTA_LABELS } from '@/lib/cuentas'
import { resumenInventario } from '@/lib/inventario'
import { gastosPorVenir } from '@/lib/costo-envios'
import { VENTA_STATUS, pedidoTotal } from '@/lib/clientes'
import { METODOS_PAGO_INGRESO, METODOS_PAGO_EGRESO } from '@/lib/pagos'
import { SITUACION_LABELS, situacionDeCobro, type SituacionCobro } from '@/lib/saldo-entrega'
import { mesDe, nombreMes } from '@/lib/margen'

export const metadata = { title: 'Contabilidad' }

const usd = (n: number) => `$${n.toFixed(2)}`
const ORDEN_SITUACION: Record<SituacionCobro, number> = { entregado: 0, parcial: 1, en_transito: 2 }
const fechaCorta = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })
const bsFmt = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
const CHIP_SITUACION: Record<SituacionCobro, string> = {
  entregado: 'bg-red-100 text-red-800',
  parcial: 'bg-amber-100 text-amber-900',
  en_transito: 'bg-gray-100 text-gray-700',
}
const CAMPO = 'h-10 w-full border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const ETIQUETA = 'flex flex-col gap-1 text-xs font-medium text-gray-600 min-w-0'
const TARJETA = 'bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0'
const pad = (n: number) => String(n).padStart(2, '0')

// Los últimos meses (hora de Venezuela) como atajos del filtro del libro: solo llenan desde/hasta.
function ultimosMeses(n: number) {
  const [a, m] = mesDe(new Date()).split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(a, m - 1 - i, 1))
    const y = d.getUTCFullYear()
    const mm = d.getUTCMonth() + 1
    const clave = `${y}-${pad(mm)}`
    return { clave, desde: `${clave}-01`, hasta: `${clave}-${pad(new Date(Date.UTC(y, mm, 0)).getUTCDate())}` }
  })
}

interface Props {
  searchParams: Promise<{ desde?: string; hasta?: string; cuenta?: string; categoria?: string; pedido?: string; n?: string }>
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
  const { desde: filtroDesde, hasta: filtroHasta, rango: rangoLibro, filtro, hayFiltro } = leerFiltroLibro(sp)
  // "Ver más" de a 50; el CSV trae todo lo filtrado.
  const limite = Math.min(Math.max(parseInt(sp.n ?? '') || 50, 50), 5000)
  const qsLibro = new URLSearchParams(
    Object.entries({ desde: sp.desde, hasta: sp.hasta, cuenta: sp.cuenta, categoria: sp.categoria, pedido: sp.pedido })
      .filter((e): e is [string, string] => !!e[1]),
  )
  const rangoCaja: RangoFechas | undefined = apertura ? { desde: apertura.desde, hasta: null } : undefined

  const cfg = toConfigMap(cfgRows)
  const [caja, porCuenta, valorBs, movimientos] = await Promise.all([
    saldoCaja(rangoCaja),
    saldosPorCuenta(rangoCaja),
    valorBsEnLibro(),
    listarMovimientos(limite, rangoLibro, filtro),
  ])
  // Los Bs del banco valen lo que darían hoy en USDT (bsd_usd_rate), no lo que se le acreditó al cliente.
  // shortcut: con movimientos del banco sin Bs anotados o la apertura en el banco no se sabe cuántos Bs
  // hay, y queda el valor en libro; se arregla anotando esos Bs.
  const tasaUsdt = num(cfg, 'bsd_usd_rate', 0)
  const banco = porCuenta.find(c => c.cuenta === 'banco_bs')
  const bancoUsdt = banco?.bs != null && banco.sinBs === 0 && apertura?.cuenta !== 'banco_bs' && tasaUsdt > 0
    ? Math.round((banco.bs / tasaUsdt) * 100) / 100
    : null
  const ajusteUsdt = bancoUsdt != null ? bancoUsdt - banco!.usd : 0
  const saldoTotal = (apertura?.saldoInicial ?? 0) + caja.saldo + ajusteUsdt

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
  const libre = saldoTotal - totalPorVenir
  const cajasEnCamino = inventario.camino.aereo.cajas + inventario.camino.maritimo.cajas

  const propsMovimiento = {
    action: crearMovimiento,
    categoriasIngreso: CATEGORIAS_INGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] })),
    categoriasEgreso: CATEGORIAS_EGRESO.map(c => ({ value: c, label: CATEGORIA_LABELS[c] })),
    metodosIngreso: METODOS_PAGO_INGRESO,
    // Pagar en Bs solo desde acá: a un proveedor de afuera no se le paga en bolívares.
    metodosEgreso: [...METODOS_PAGO_EGRESO, METODOS_PAGO_INGRESO[0]],
    pedidos: pedidosConfirmados.map(p => ({ id: p.id, clientName: p.clientName })),
    envios,
    suppliers,
    tasaBsSugerida: num(cfg, 'bsd_usd_rate', 0),
    tasaBcvSugerida: num(cfg, 'bcv_usd_rate', 0),
    // Un egreso en Bs sale a lo que valen en el libro (costo promedio), como una conversión.
    tasaLibroBs: valorBs ? 1 / valorBs : num(cfg, 'bsd_usd_rate', 0),
  }

  // Fechas del libro: "5 nov", con el año solo si no es este; en hora de Venezuela.
  const anioActual = mesDe(new Date()).slice(0, 4)
  const fechaFila = (d: Date) => d.toLocaleDateString('es-VE', {
    day: 'numeric', month: 'short', timeZone: 'America/Caracas', ...(mesDe(d).slice(0, 4) !== anioActual ? { year: 'numeric' } : {}),
  })
  const meses = ultimosMeses(4)
  const mesElegido = meses.find(m => m.desde === filtroDesde && m.hasta === filtroHasta) ?? null
  const etiquetaMes = (clave: string) => {
    const t = nombreMes(clave)
    const corto = clave.startsWith(anioActual) ? t.replace(/ de \d{4}$/, '') : t
    return corto.charAt(0).toUpperCase() + corto.slice(1)
  }
  // Un atajo de mes cambia solo las fechas: cuenta, categoría y pedido se mantienen.
  const conFechas = (desde?: string, hasta?: string) => {
    const u = new URLSearchParams(qsLibro)
    u.delete('desde')
    u.delete('hasta')
    if (desde) u.set('desde', desde)
    if (hasta) u.set('hasta', hasta)
    return u.size ? `/contabilidad?${u}` : '/contabilidad'
  }
  const otrosFiltros = !!(sp.cuenta || sp.categoria || sp.pedido)
  // "Más filtros" arranca abierto si hay un filtro que los atajos de mes no muestran.
  const filtrosAbiertos = otrosFiltros || (!!(filtroDesde || filtroHasta) && !mesElegido)
  const periodo = mesElegido ? `en ${nombreMes(mesElegido.clave)}`
    : filtroDesde || filtroHasta ? `del ${filtroDesde ?? 'inicio'} al ${filtroHasta ?? 'hoy'}`
      : 'de todos los meses'

  const categoriaDe = (c: string) => CATEGORIA_LABELS[c as keyof typeof CATEGORIA_LABELS] ?? c
  const cuentaDe = (c: string | null) => c ? CUENTA_LABELS[c as keyof typeof CUENTA_LABELS] ?? c : 'Sin cuenta'
  const montoTexto = (m: MovimientoRow) => `${m.tipo === 'ingreso' ? '+' : '−'}${m.montoBs != null ? `Bs ${bsFmt(m.montoBs)}` : usd(m.monto)}`
  const referencia = (m: MovimientoRow) =>
    m.pedido ? <Link href={`/presupuestos/${m.pedido.id}`} className="text-blue-700 hover:underline [overflow-wrap:anywhere]">{m.pedido.clientName}</Link>
      : m.envio ? <Link href={`/envios/${m.envio.id}`} className="text-blue-700 hover:underline [overflow-wrap:anywhere]">{m.envio.nombre ?? `Envío #${m.envio.id}`}</Link>
        : m.supplier ? <span className="text-gray-700 [overflow-wrap:anywhere]">{m.supplier.name}</span>
          : null
  const monto = (m: MovimientoRow) => (
    <>
      {/* En Bs manda lo que pasó por el banco; los dólares son lo que abonó, de referencia. */}
      <span className={`font-semibold tabular-nums ${m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'}`}>{montoTexto(m)}</span>
      {m.montoBs != null && <span className="block text-xs text-gray-500 tabular-nums">{usd(m.monto)}</span>}
    </>
  )
  const borrar = (m: MovimientoRow) => (
    <DeleteButton
      action={eliminarMovimiento.bind(null, m.id)}
      ariaLabel={`Eliminar ${categoriaDe(m.categoria).toLowerCase()} del ${fechaFila(m.fecha)}, ${montoTexto(m)}`}
      className="inline-flex items-center min-h-8 px-2 rounded-md hover:bg-red-50"
      confirmMessage={m.grupo ? 'Es una conversión: se borran las dos patas (la salida en Bs y la entrada a USDT). ¿Seguir?' : '¿Eliminar este movimiento del libro?'}
    />
  )

  const libro = (
    <SeccionCaja
      id="libro-h"
      titulo="Libro"
      sub={`${movimientos.length === limite ? `Los últimos ${limite} movimientos` : plural(movimientos.length, 'movimiento', 'movimientos')} ${periodo}${otrosFiltros ? ', con filtros' : ''}.`}
      acciones={
        <a href={`/contabilidad/csv?${qsLibro}`} className="inline-flex items-center min-h-10 px-1 text-sm text-blue-700 hover:underline">
          Exportar CSV
        </a>
      }
    >
      <div className="px-4 sm:px-6 py-3 space-y-2 border-b border-gray-100">
        <div role="group" aria-label="Mes" className="flex flex-wrap items-center gap-2">
          {[
            { clave: 'todo', href: conFechas(), texto: 'Todo', activo: !filtroDesde && !filtroHasta },
            ...meses.map(m => ({ clave: m.clave, href: conFechas(m.desde, m.hasta), texto: etiquetaMes(m.clave), activo: mesElegido?.clave === m.clave })),
          ].map(c => (
            <Link
              key={c.clave}
              href={c.href}
              aria-current={c.activo ? 'true' : undefined}
              className={`inline-flex items-center min-h-8 px-3 rounded-full border text-sm font-medium transition-colors ${
                c.activo ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {c.texto}
            </Link>
          ))}
          {hayFiltro && (
            <Link href="/contabilidad" className="inline-flex items-center min-h-8 px-2 text-sm text-gray-600 hover:text-gray-900 hover:underline">
              Quitar filtros
            </Link>
          )}
        </div>
        <details open={filtrosAbiertos} className="group">
          <summary className="inline-flex items-center gap-1.5 min-h-8 cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">
            <span aria-hidden="true" className="text-xs text-gray-500 transition-transform group-open:rotate-90">▶</span>
            Más filtros
          </summary>
          <form role="search" aria-label="Filtrar el libro" className="mt-2 mb-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
            <label className={ETIQUETA}>Desde<input type="date" name="desde" defaultValue={filtroDesde ?? ''} className={CAMPO} /></label>
            <label className={ETIQUETA}>Hasta<input type="date" name="hasta" defaultValue={filtroHasta ?? ''} className={CAMPO} /></label>
            <label className={ETIQUETA}>
              Cuenta
              <select name="cuenta" defaultValue={sp.cuenta ?? ''} className={CAMPO}>
                <option value="">Todas</option>
                {CUENTAS.map(c => <option key={c} value={c}>{CUENTA_LABELS[c]}</option>)}
              </select>
            </label>
            <label className={ETIQUETA}>
              Categoría
              <select name="categoria" defaultValue={sp.categoria ?? ''} className={CAMPO}>
                <option value="">Todas</option>
                {Object.entries(CATEGORIA_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={ETIQUETA}>
              Pedido
              <input name="pedido" inputMode="numeric" defaultValue={sp.pedido ?? ''} placeholder="#" className={CAMPO} />
            </label>
            <button type="submit" className="h-10 px-4 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50">
              Filtrar
            </button>
          </form>
        </details>
      </div>

      {movimientos.length === 0 ? (
        <div className="px-4 sm:px-6 py-10 text-center text-sm text-gray-600">
          <p>{hayFiltro ? 'Nada con esos filtros.' : 'Todavía no hay movimientos cargados.'}</p>
          <p className="mt-2">
            {hayFiltro
              ? <Link href="/contabilidad" className="text-blue-700 hover:underline">Ver todo el libro</Link>
              : <a href="#anotar" className="text-blue-700 hover:underline">Anotar el primero</a>}
          </p>
        </div>
      ) : (
        <>
          <div className="hidden xl:block overflow-x-auto">
            {/* Anchos fijos: un nombre larguísimo se corta en su columna en vez de aplastar las demás. */}
            <table className="w-full text-sm table-fixed">
              <thead className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                <tr>
                  <th scope="col" className="w-28 text-left font-medium pl-6 pr-4 py-2.5 whitespace-nowrap">Fecha</th>
                  <th scope="col" className="text-left font-medium px-4 py-2.5">Concepto</th>
                  <th scope="col" className="w-36 text-left font-medium px-4 py-2.5">Cuenta</th>
                  <th scope="col" className="text-left font-medium px-4 py-2.5">De quién / para qué</th>
                  <th scope="col" className="w-44 text-right font-medium px-4 py-2.5">Monto</th>
                  <th scope="col" className="w-28 pl-2 pr-4 py-2.5"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {movimientos.map(m => (
                  <tr key={m.id} className="align-top hover:bg-gray-50">
                    <td className="pl-6 pr-4 py-2.5 text-gray-600 whitespace-nowrap tabular-nums">{fechaFila(m.fecha)}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-900">{categoriaDe(m.categoria)}</span>
                      {m.descripcion && <span className="block text-xs text-gray-600 [overflow-wrap:anywhere] text-pretty">{m.descripcion}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{cuentaDe(m.cuenta)}</td>
                    <td className="px-4 py-2.5">{referencia(m) ?? <span className="text-gray-500">—</span>}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{monto(m)}</td>
                    <td className="pl-2 pr-4 py-1.5 text-right">{borrar(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="xl:hidden divide-y divide-gray-100">
            {movimientos.map(m => (
              <li key={m.id} className="px-4 sm:px-6 py-3 flex gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500 tabular-nums">{fechaFila(m.fecha)} · {cuentaDe(m.cuenta)}</p>
                  <p className="text-sm font-medium text-gray-900">{categoriaDe(m.categoria)}</p>
                  {m.descripcion && <p className="text-xs text-gray-600 break-words text-pretty">{m.descripcion}</p>}
                  {referencia(m) && <p className="text-sm mt-0.5">{referencia(m)}</p>}
                </div>
                <div className="shrink-0 text-right text-sm flex flex-col items-end gap-1">
                  <span>{monto(m)}</span>
                  {borrar(m)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {movimientos.length === limite && (
        <div className="px-4 sm:px-6 py-3 border-t border-gray-100 text-center">
          <Link
            href={`/contabilidad?${new URLSearchParams([...qsLibro, ['n', String(limite + 50)]])}`}
            scroll={false}
            className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline"
          >
            Ver 50 más
          </Link>
        </div>
      )}
    </SeccionCaja>
  )

  const cobrar = (
    <SeccionCaja
      id="cobrar-h"
      titulo="Por cobrar"
      sub={porCobrar.length === 0
        ? 'Ningún pedido confirmado tiene saldo.'
        : `${plural(porCobrar.length, 'pedido', 'pedidos')} con saldo, ${usd(totalPorCobrar)}. Lo entregado sin pagar va primero.`}
    >
      {porCobrar.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {porCobrar.map(p => (
            <li key={p.pedidoId} className={`px-4 sm:px-6 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 ${p.situacion === 'entregado' ? 'bg-red-50/50' : ''}`}>
              <div className="min-w-0 flex-1">
                <Link href={`/presupuestos/${p.pedidoId}`} className="text-blue-700 hover:underline break-words">{p.clientName}</Link>
                <span className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${CHIP_SITUACION[p.situacion]}`}>
                  {SITUACION_LABELS[p.situacion]}
                </span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-amber-800">{usd(p.falta)}</span>
              <span className="text-xs tabular-nums text-gray-500 min-w-20 text-right">de {usd(p.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </SeccionCaja>
  )

  const hayPiso = porVenir.cajas.some(g => g.incompleto)
  const pagar = (
    <SeccionCaja
      id="pagar-h"
      titulo="Por pagar"
      sub={porVenir.cajas.length === 0
        ? 'Ninguna caja en curso con gastos pendientes.'
        : `Flete y proveedor de ${plural(porVenir.cajas.length, 'caja', 'cajas')} en curso, ${usd(totalPorVenir)}.`}
    >
      {porVenir.cajas.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {porVenir.cajas.map(g => (
            <li key={g.envioId} className="px-4 sm:px-6 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <Link href={`/envios/${g.envioId}`} className="text-blue-700 hover:underline break-words">{g.nombre ?? `Envío #${g.envioId}`}</Link>
                <span className="block text-xs text-gray-600">
                  {[
                    g.fletePorPagarUsd > 0.005 && `flete ${usd(g.fletePorPagarUsd)} ${g.fleteEstimado ? 'estimado' : 'facturado'}`,
                    g.proveedorPorPagarUsd > 0.005 && `proveedor ${usd(g.proveedorPorPagarUsd)}`,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-amber-800">{g.incompleto && 'desde '}{usd(g.totalUsd)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Pagado de más: no es "cero por pagar", es plata que salió y no figura debida.
          Puede ser un pago repetido, un costo real mal cargado o un flete anotado como
          pago al proveedor. Se muestra aparte para que no desaparezca del listado. */}
      {sobrepagadas.length > 0 && (
        <div className="border-t border-red-100 bg-red-50/40">
          <h3 className="text-xs font-semibold text-red-800 px-4 sm:px-6 pt-3">Pagado de más al proveedor</h3>
          <ul className="divide-y divide-red-100">
            {sobrepagadas.map(e => (
              <li key={e.envioId} className="px-4 sm:px-6 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <Link href={`/envios/${e.envioId}`} className="text-blue-700 hover:underline break-words">{e.nombre ?? `Envío #${e.envioId}`}</Link>
                  <span className="block text-xs text-gray-600">{e.supplierName} · {usd(e.pagado)} pagado de {usd(e.debido)}</span>
                </div>
                <span className="text-sm font-semibold tabular-nums text-red-700">+{usd(-e.pendiente)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hayPiso && (
        <p className="px-4 sm:px-6 py-2.5 text-xs text-gray-600 border-t border-gray-100">
          «desde»: estimado de piso, a esa caja le faltan pesos, medidas o costos.
        </p>
      )}
    </SeccionCaja>
  )

  const anotar = (
    <SeccionCaja
      id="anotar-h"
      titulo="Anotar en el libro"
      sub="Cobros, pagos y gastos sueltos. Lo de un pedido o de una caja también se anota desde su ficha."
    >
      <div className="px-4 sm:px-6 py-4 max-w-3xl">
        <AnotarLibro
          paneles={{
            ingreso: <MovimientoForm tipo="ingreso" {...propsMovimiento} />,
            egreso: <MovimientoForm tipo="egreso" {...propsMovimiento} />,
            usdt: <ConversionForm action={crearConversion} valor={valorBs} />,
          }}
        />
      </div>
    </SeccionCaja>
  )

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 text-balance">Contabilidad</h1>
          <p className="text-sm text-gray-500 mt-1 text-pretty">La plata que hay, la que te deben y la que falta pagar.</p>
        </div>
        <Link
          href="/contabilidad/comprar"
          className="inline-flex items-center gap-2 min-h-10 px-4 rounded-lg text-sm font-semibold text-gray-800 border border-gray-300 bg-white hover:bg-gray-50"
        >
          Registrar compra
          {pendientesCosto.length > 0 && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900">
              {pendientesCosto.length} sin costo
            </span>
          )}
        </Link>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 items-start">
          <div className={`col-span-2 lg:col-span-1 ${TARJETA}`}>
            <p className="text-xs text-gray-500">Saldo de caja</p>
            <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${saldoTotal >= 0 ? 'text-gray-900' : 'text-red-700'}`}>{usd(saldoTotal)}</p>
            {/* Dónde está: lo que suman las cuentas, más la apertura, es el saldo de arriba. */}
            <dl className="mt-2 space-y-0.5 text-sm">
              {porCuenta.map(c => ({ ...c, usd: c.usd + (apertura && c.cuenta === apertura.cuenta ? apertura.saldoInicial : 0) })).map(c => (
                <div key={c.cuenta ?? 'sin'} className="flex justify-between gap-3">
                  <dt className="text-gray-600">{c.cuenta ? CUENTA_LABELS[c.cuenta] : 'Sin cuenta'}</dt>
                  {/* El banco se ve en bolívares, y al lado lo que valen a tasa USDT (lo que suma arriba). */}
                  <dd className="tabular-nums text-gray-900 text-right">
                    {c.bs != null
                      ? `Bs ${bsFmt(c.bs)}${c.sinBs > 0 ? '+' : ''}${bancoUsdt != null ? ` ≈ ${usd(bancoUsdt)}` : ''}`
                      : usd(c.usd)}
                  </dd>
                </div>
              ))}
              {apertura && !apertura.cuenta && (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-600">Apertura</dt>
                  <dd className="tabular-nums text-gray-900">{usd(apertura.saldoInicial)}</dd>
                </div>
              )}
            </dl>
            {apertura ? (
              <details className="mt-2 text-xs text-gray-600">
                <summary className="inline-flex items-center min-h-8 cursor-pointer text-sm text-blue-700 hover:underline">Cómo se calcula</summary>
                <p className="tabular-nums text-pretty">
                  {`${usd(apertura.saldoInicial)} de apertura (${fechaCorta(apertura.desde)}) + ${usd(caja.ingresos)} ingresos − ${usd(caja.egresos)} egresos`}
                  {Math.abs(caja.costoConversion) >= 0.005 && (caja.costoConversion > 0
                    ? ` − ${usd(caja.costoConversion)} que costó convertir a USDT`
                    : ` + ${usd(-caja.costoConversion)} ganados al convertir a USDT`)}
                  {Math.abs(ajusteUsdt) >= 0.005 && ` ${ajusteUsdt > 0 ? '+' : '−'} ${usd(Math.abs(ajusteUsdt))} al valorar los Bs a tasa USDT`}.
                </p>
                <AperturaCajaForm
                  action={guardarAperturaCaja}
                  actual={{ desde: apertura.desde.toISOString().slice(0, 10), saldoInicial: apertura.saldoInicial, cuenta: apertura.cuenta }}
                />
              </details>
            ) : (
              <div className="mt-1 text-xs text-gray-600">
                <p className="tabular-nums">{usd(caja.ingresos)} ingresos − {usd(caja.egresos)} egresos.</p>
                <AperturaCajaForm action={guardarAperturaCaja} actual={null} />
              </div>
            )}
          </div>

          <div className={TARJETA}>
            <p className="text-xs text-gray-500">Libre después de pagar</p>
            {/* El mínimo a guardar: lo que queda del saldo si sale todo lo comprometido. */}
            <p className={`text-xl sm:text-3xl font-bold tabular-nums break-words ${libre >= 0 ? 'text-gray-900' : 'text-red-700'}`}>{usd(libre)}</p>
            <p className="text-xs text-gray-600 mt-1 text-pretty">
              {porVenir.cajas.length === 0
                ? 'Nada comprometido en cajas en curso.'
                : `${usd(totalPorVenir)} por pagar en ${plural(porVenir.cajas.length, 'caja', 'cajas')}`}
            </p>
            {sobrepagadas.length > 0 && (
              <a href="#pagar" className="inline-flex items-center min-h-8 text-xs font-semibold text-red-700 hover:underline">
                {plural(sobrepagadas.length, 'caja pagada', 'cajas pagadas')} de más
              </a>
            )}
          </div>

          <a
            href="#cobrar"
            className={`block rounded-xl border p-4 sm:p-5 min-w-0 transition-colors ${
              porCobrar.length > 0 ? 'bg-amber-50 border-amber-200 hover:border-amber-400' : 'bg-white border-gray-100 shadow-sm hover:border-gray-300'
            }`}
          >
            <p className={`text-xs ${porCobrar.length > 0 ? 'text-amber-900' : 'text-gray-500'}`}>Por cobrar</p>
            <p className={`text-xl sm:text-3xl font-bold tabular-nums break-words ${porCobrar.length > 0 ? 'text-amber-900' : 'text-gray-900'}`}>{usd(totalPorCobrar)}</p>
            <p className={`text-xs mt-1 ${porCobrar.length > 0 ? 'text-amber-900' : 'text-gray-600'}`}>{plural(porCobrar.length, 'pedido', 'pedidos')} con saldo</p>
            {sinPagarEntregado > 0.005 && (
              <p className="text-xs font-semibold text-red-800 mt-0.5">{usd(sinPagarEntregado)} ya entregado sin pagar</p>
            )}
          </a>
        </div>

        <p className="text-sm text-gray-600 flex flex-wrap gap-x-2 gap-y-0.5">
          <span>Inventario <strong className="font-semibold text-gray-900 tabular-nums">{usd(inventario.aqui.valorUsd + inventario.camino.valorUsd)}</strong>:</span>
          <span className="tabular-nums">
            {usd(inventario.aqui.valorUsd)} aquí ({plural(inventario.aqui.productos, 'producto', 'productos')}) + {usd(inventario.camino.valorUsd)} en camino
            {inventario.camino.unidades > 0 && ` (${inventario.camino.unidades} u. en ${plural(cajasEnCamino, 'caja confirmada', 'cajas confirmadas')}${inventario.camino.incompleto ? ', estimado: faltan datos de alguna caja' : ''})`}
          </span>
          {inventario.aqui.sinCosto > 0 && <span>· {inventario.aqui.sinCosto} sin costo cargado, no están en la suma</span>}
          <Link href="/inventario" className="inline-flex items-center min-h-8 text-blue-700 hover:underline">Ver piezas →</Link>
        </p>
      </div>

      <PestanasCaja
        etiqueta="Secciones de contabilidad"
        inicial="libro"
        pestanas={[
          { id: 'libro', label: 'Libro', contenido: libro },
          { id: 'cobrar', label: 'Por cobrar', badge: porCobrar.length ? String(porCobrar.length) : null, contenido: cobrar },
          { id: 'pagar', label: 'Por pagar', badge: porVenir.cajas.length + sobrepagadas.length ? String(porVenir.cajas.length + sobrepagadas.length) : null, contenido: pagar },
          { id: 'anotar', label: 'Anotar', contenido: anotar },
        ]}
      />
    </div>
  )
}
