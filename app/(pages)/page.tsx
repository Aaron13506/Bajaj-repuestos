import { db } from '@/lib/db'
import Link from 'next/link'
import { resumenInventario } from '@/lib/inventario'
import { cuentasPorPagar } from '@/lib/movimientos'
import { toConfigMap, num } from '@/lib/config'
import { saldoReal, situacionDeCobro, debeSaldo, SITUACION_LABELS } from '@/lib/saldo-entrega'
import { estadoValidez, validezDias } from '@/lib/validez'
import { DIAS_CAJA_PARADA, diasSinMoverse } from '@/lib/etapas'
import { VENTA_STATUS } from '@/lib/clientes'
import { MODOS_CON_PEDIDOS } from '@/lib/modo'
import { trackingsConNovedad, type NovedadTracking } from '@/lib/novedades'
import { horaConsulta, metaEstado } from '@/lib/ship24'
import VenderDelDeposito from '@/components/VenderDelDeposito'
import YaLoVi from '@/components/YaLoVi'

export const metadata = { title: 'Inicio' }

// Lo que ves al abrir: vender lo que te piden, qué se movió desde la última vez y qué hay
// que hacer hoy. No conteos del catálogo (revisión de negocio 3.2): "stock bajo" sobre miles
// de piezas en cero en un negocio por encargo era ruido.

const usd = (n: number) => `$${n.toFixed(2)}`
const pl = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
// Cada grupo muestra hasta este número; el resto se ve en la pantalla de la lista completa.
const MAX_FILAS = 8
const dec = (v: { toString(): string } | null) => (v != null ? parseFloat(v.toString()) : null)
// Presupuestos que vencen en estos días o menos: hay que llamar al cliente antes.
const DIAS_AVISO_VENCE = 2
// Los mismos títulos que el trayecto de la ficha de caja (TrayectoCaja).
const TRAMO: Record<string, string> = { local: 'Local en India', usa: 'Aéreo a USA', venezuela: 'Miami → Caracas' }
const tramoDe = (t: string, express: boolean) => (express && t === 'venezuela' ? 'Express a Venezuela' : TRAMO[t] ?? t)
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
// "2026-11-07T08:05:00+05:30" → "7 nov, 08:05": la hora del courier tal cual, sin convertir (puede no tener zona).
function fechaCorta(s: string, conHora = true): string {
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/)
  if (!m || !MESES[Number(m[1]) - 1]) return s
  return `${Number(m[2])} ${MESES[Number(m[1]) - 1]}${conHora && m[3] ? `, ${m[3]}` : ''}`
}
// Para ordenar eventos de couriers distintos; una fecha ilegible va al final.
const msDe = (fecha: string | null | undefined) => (fecha ? Date.parse(fecha) || 0 : 0)

async function getDatos() {
  // Todo independiente: una sola tanda, la latencia se paga una vez.
  const [cfgRows, pedidos, porComprar, sinCaja, cajas, abiertos, cuentas, inventario, novedades, sinSeguir, consulta, stock] = await Promise.all([
    db.config.findMany(),
    db.pedido.findMany({
      where: { status: VENTA_STATUS, tipo: { not: 'propio' } },
      select: {
        id: true, clientName: true, depositUsd: true,
        items: { select: { salePrice: true, quantity: true, shippingStatus: true } },
      },
    }),
    // Por comprar: líneas de pedidos confirmados sin compra registrada, fuera de cajas en borrador
    // (el mismo criterio que /contabilidad/comprar).
    db.pedidoItem.groupBy({
      by: ['pedidoId'],
      where: {
        costRealUsd: null,
        pedido: { status: VENTA_STATUS, tipo: 'cliente' },
        OR: [{ envioId: null }, { envio: { estado: { not: 'borrador' } } }],
      },
      _count: { _all: true },
    }),
    db.pedidoItem.count({ where: { envioId: null, costRealUsd: null, pedido: { status: VENTA_STATUS, tipo: 'cliente' } } }),
    db.envio.findMany({
      where: { modo: { in: [...MODOS_CON_PEDIDOS] }, estado: { not: 'borrador' } },
      select: {
        id: true, nombre: true, supplier: { select: { name: true } },
        items: { select: { shippingStatus: true, shippingStatusAt: true } },
        // Para decir qué fue lo último que contó un courier de una caja parada.
        trackings: { where: { ultimoEvento: { not: null } }, select: { transportista: true, ultimoEvento: true, ultimoEventoEn: true } },
      },
    }),
    db.pedido.findMany({
      where: { tipo: 'cliente', status: 'presupuesto', perdidoAt: null },
      select: { id: true, clientName: true, createdAt: true, cotizadoAt: true },
    }),
    cuentasPorPagar(),
    resumenInventario(),
    trackingsConNovedad(),
    db.envioTracking.findMany({
      where: { errorSeguimiento: { not: null } },
      select: { id: true, envioId: true, tramo: true, numero: true, transportista: true, errorSeguimiento: true, envio: { select: { nombre: true } } },
      orderBy: { envioId: 'desc' },
    }),
    db.envioTracking.aggregate({ _max: { consultadoEn: true } }),
    db.product.aggregate({ where: { stock: { gt: 0 } }, _count: { _all: true }, _sum: { stock: true } }),
  ])
  const cfg = toConfigMap(cfgRows)

  const entregadoSinPagar = pedidos
    .map(p => {
      const items = p.items.map(i => ({ salePrice: Number(i.salePrice), quantity: i.quantity, shippingStatus: i.shippingStatus }))
      return { id: p.id, clientName: p.clientName, saldo: saldoReal(items, dec(p.depositUsd)), situacion: situacionDeCobro(items) }
    })
    .filter(p => debeSaldo(p.saldo) && p.situacion !== 'en_transito')
    .sort((a, b) => b.saldo - a.saldo)

  const paradas = cajas
    .map(c => {
      const ultimo = [...c.trackings].sort((a, b) => msDe(b.ultimoEventoEn) - msDe(a.ultimoEventoEn))[0]
      return { id: c.id, nombre: c.nombre ?? `Caja #${c.id}`, proveedor: c.supplier?.name ?? null, dias: diasSinMoverse(c.items), ultimo }
    })
    .filter((c): c is typeof c & { dias: number } => c.dias != null && c.dias >= DIAS_CAJA_PARADA)
    .sort((a, b) => b.dias - a.dias)

  const dias = validezDias(cfg)
  const vigencias = abiertos.map(p => ({ ...p, v: estadoValidez(p, dias) }))
  const porVencer = vigencias.filter(p => !p.v.vencido && p.v.diasRestantes <= DIAS_AVISO_VENCE).sort((a, b) => a.v.diasRestantes - b.v.diasRestantes)
  const vencidos = vigencias.filter(p => p.v.vencido).length

  const deuda = cuentas.pendientes.reduce((s, e) => s + Math.max(0, e.pendiente), 0)

  return {
    entregadoSinPagar, paradas, porVencer, vencidos, deuda, cuentas, inventario, sinSeguir,
    novedades: novedades.sort((a, b) => msDe(b.ultimo.fecha) - msDe(a.ultimo.fecha)),
    consultadoEn: consulta._max.consultadoEn,
    stock: { piezas: stock._count._all, unidades: stock._sum.stock ?? 0 },
    tasaBcv: num(cfg, 'bcv_usd_rate', 0),
    porComprar: { lineas: porComprar.reduce((s, g) => s + g._count._all, 0), pedidos: porComprar.length, sinCaja },
  }
}

export default async function DashboardPage() {
  const d = await getDatos()
  const hoy = new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas', weekday: 'long', day: 'numeric', month: 'long' })
  const bcv = d.tasaBcv > 0 ? ` · dólar BCV Bs ${d.tasaBcv.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 text-balance">Inicio</h1>
          <p className="text-sm text-gray-500 mt-1 first-letter:uppercase">{hoy}{bcv}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/presupuestos/new" className="inline-flex items-center justify-center min-h-10 px-4 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50">
            Nuevo presupuesto
          </Link>
          <Link href="/ventas/new" className="inline-flex items-center justify-center min-h-10 bg-blue-600 text-white px-4 rounded-lg text-sm font-semibold hover:bg-blue-700">
            Nueva venta
          </Link>
        </div>
      </div>

      <VenderDelDeposito piezas={d.stock.piezas} unidades={d.stock.unidades} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <Novedades novedades={d.novedades} sinSeguir={d.sinSeguir} consultadoEn={d.consultadoEn} />
        <ParaHoy d={d} />
      </div>

      <p className="text-sm text-gray-600 flex flex-wrap gap-x-5 gap-y-1">
        <Link href="/inventario" className="inline-flex flex-wrap items-baseline gap-x-1 min-h-8 py-1 hover:underline">
          Inventario <strong className="text-gray-900 tabular-nums">{usd(d.inventario.aqui.valorUsd + d.inventario.camino.valorUsd)}</strong>
          <span className="text-gray-500 tabular-nums">({usd(d.inventario.aqui.valorUsd)} aquí + {usd(d.inventario.camino.valorUsd)} en camino)</span>
        </Link>
        <Link href="/contabilidad" className="inline-flex flex-wrap items-baseline gap-x-1 min-h-8 py-1 hover:underline">
          Deuda con proveedores <strong className="text-gray-900 tabular-nums">{usd(d.deuda)}</strong>
          <span className="text-gray-500">({pl(d.cuentas.pendientes.length, 'caja', 'cajas')})</span>
          {d.cuentas.sobrepagadas.length > 0 && (
            <span className="text-red-700 font-medium">· {pl(d.cuentas.sobrepagadas.length, 'pagada de más', 'pagadas de más')}</span>
          )}
        </Link>
      </p>
    </div>
  )
}

function Novedades({ novedades, sinSeguir, consultadoEn }: {
  novedades: NovedadTracking[]
  sinSeguir: { id: number; envioId: number; tramo: string; numero: string; transportista: string | null; errorSeguimiento: string | null; envio: { nombre: string | null } }[]
  consultadoEn: Date | null
}) {
  const visibles = novedades.slice(0, MAX_FILAS)
  const resto = novedades.length - visibles.length
  return (
    <section aria-labelledby="novedades-h" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-gray-100">
        <div className="min-w-0">
          <h2 id="novedades-h" className="text-base font-semibold text-gray-900 text-balance">
            Desde tu última visita
            {novedades.length > 0 && (
              <span className="ml-2 align-middle text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-600 text-white tabular-nums">
                {pl(novedades.length, 'novedad', 'novedades')}
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500">
            {consultadoEn ? `Trackings consultados el ${horaConsulta(consultadoEn)}` : 'Ningún tracking consultado todavía'}
          </p>
        </div>
        {visibles.length > 0 && <YaLoVi vistos={visibles.map(n => ({ id: n.id, clave: n.clave }))} />}
      </div>

      {visibles.length === 0 ? (
        <p className="px-4 sm:px-5 py-4 text-sm text-gray-500 text-pretty">
          Nada nuevo. Cuando un courier registre un movimiento en una caja, aparece acá. <Link href="/envios" className="text-blue-700 hover:underline">Ver cajas</Link>
        </p>
      ) : (
        <ul className="px-4 sm:px-5 divide-y divide-gray-100">
          {visibles.map(n => {
            const ahora = metaEstado(n.estado)
            const antes = n.antes && n.antes !== n.estado ? metaEstado(n.antes) : null
            return (
              <li key={n.id} className="py-3">
                <p className="text-sm">
                  <Link href={`/envios/${n.envioId}#tramo-${n.tramo}`} className="font-medium text-blue-700 hover:underline">{n.caja}</Link>
                  <span className="text-gray-500"> · {tramoDe(n.tramo, n.express)}</span>
                </p>
                {(antes || ahora) && (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {antes && (
                      <>
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${antes.color}`}>{antes.label}</span>
                        <span aria-hidden="true" className="text-xs text-gray-500">→</span>
                        <span className="sr-only">pasó a</span>
                      </>
                    )}
                    {ahora && <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${ahora.color}`}>{ahora.label}</span>}
                  </p>
                )}
                <p className="text-sm text-gray-700 mt-1 break-words text-pretty">
                  {n.ultimo.detalle}
                  {n.nuevos != null && n.nuevos > 1 && <span className="text-gray-500"> · {n.nuevos} eventos nuevos</span>}
                </p>
                <p className="text-xs text-gray-500 mt-0.5 break-words">
                  {[n.transportista, n.numero, n.ultimo.lugar, n.ultimo.fecha && `${fechaCorta(n.ultimo.fecha)} (hora del courier)`].filter(Boolean).join(' · ')}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      {resto > 0 && (
        <p className="px-4 sm:px-5 pb-3 text-xs text-gray-500">Y {pl(resto, 'otra', 'otras')}: aparecen cuando marques estas como vistas.</p>
      )}

      {sinSeguir.length > 0 && (
        <div className="mx-4 sm:mx-5 mb-4 mt-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-semibold">{sinSeguir.length === 1 ? 'Un tracking no se sigue' : `${sinSeguir.length} trackings no se siguen`}</p>
          <ul className="mt-1 space-y-1">
            {sinSeguir.slice(0, MAX_FILAS).map(t => (
              <li key={t.id} className="break-words">
                <Link href={`/envios/${t.envioId}#tramo-${t.tramo}`} className="font-medium underline">{t.envio.nombre ?? `Caja #${t.envioId}`}</Link>
                {' · '}{[t.transportista, t.numero].filter(Boolean).join(' ')}: {t.errorSeguimiento}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

type Pendiente = { key: string; tipo: string; cls: string; href: string; titulo: string; sub?: string; der: string }

function ParaHoy({ d }: { d: Awaited<ReturnType<typeof getDatos>> }) {
  const filas: Pendiente[] = []
  const mas = (total: number, tipo: string, href: string, que: string) => {
    if (total > MAX_FILAS) filas.push({ key: `mas-${tipo}`, tipo, cls: 'bg-gray-100 text-gray-700', href, titulo: `${total - MAX_FILAS} ${que} más`, der: 'Ver →' })
  }

  for (const p of d.entregadoSinPagar.slice(0, MAX_FILAS)) {
    filas.push({ key: `c${p.id}`, tipo: 'Cobrar', cls: 'bg-red-100 text-red-800', href: `/presupuestos/${p.id}`, titulo: `#${p.id} ${p.clientName}`, sub: SITUACION_LABELS[p.situacion], der: usd(p.saldo) })
  }
  mas(d.entregadoSinPagar.length, 'Cobrar', '/contabilidad', 'por cobrar')
  for (const p of d.porVencer.slice(0, MAX_FILAS)) {
    filas.push({ key: `v${p.id}`, tipo: 'Vence', cls: 'bg-amber-100 text-amber-900', href: `/presupuestos/${p.id}`, titulo: `#${p.id} ${p.clientName}`, sub: 'Presupuesto: llamar antes de que venza', der: p.v.diasRestantes === 0 ? 'hoy' : pl(p.v.diasRestantes, 'día', 'días') })
  }
  mas(d.porVencer.length, 'Vence', '/presupuestos', 'por vencer')
  for (const c of d.paradas.slice(0, MAX_FILAS)) {
    const u = c.ultimo
    const sub = u ? `${u.transportista ?? 'Courier'}: «${u.ultimoEvento}»${u.ultimoEventoEn ? ` (${fechaCorta(u.ultimoEventoEn, false)})` : ''}` : `${c.proveedor ?? '99rpm'} · sin tracking con eventos`
    filas.push({ key: `p${c.id}`, tipo: 'Parada', cls: 'bg-amber-100 text-amber-900', href: `/envios/${c.id}`, titulo: c.nombre, sub, der: pl(c.dias, 'día', 'días') })
  }
  mas(d.paradas.length, 'Parada', '/envios', 'cajas paradas')
  if (d.porComprar.lineas > 0) {
    filas.push({
      key: 'comprar', tipo: 'Comprar', cls: 'bg-blue-100 text-blue-800', href: '/contabilidad/comprar',
      titulo: `${pl(d.porComprar.lineas, 'línea', 'líneas')} en ${pl(d.porComprar.pedidos, 'pedido', 'pedidos')}`,
      sub: d.porComprar.sinCaja > 0 ? `${d.porComprar.sinCaja} sin caja todavía` : 'Registrar lo que compraste', der: 'Registrar',
    })
  }
  if (d.vencidos > 0) {
    filas.push({ key: 'vencidos', tipo: 'Vencidos', cls: 'bg-gray-100 text-gray-700', href: '/presupuestos', titulo: pl(d.vencidos, 'presupuesto sin respuesta', 'presupuestos sin respuesta'), sub: 'Renovar o marcar perdido', der: 'Ver →' })
  }

  return (
    <section aria-labelledby="hoy-h" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-gray-100">
        <h2 id="hoy-h" className="text-base font-semibold text-gray-900">Para hacer hoy</h2>
        <p className="text-xs text-gray-500">Cobros, presupuestos que vencen en {DIAS_AVISO_VENCE} días, cajas {DIAS_CAJA_PARADA}+ días quietas y compras</p>
      </div>
      {filas.length === 0 ? (
        <p className="px-4 sm:px-5 py-4 text-sm text-gray-500 text-pretty">
          Nada pendiente: nadie debe lo que se llevó, ninguna caja está parada y no vence ningún presupuesto.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {filas.map(f => (
            <li key={f.key}>
              <Link href={f.href} className="px-4 sm:px-5 py-3 flex items-center gap-3 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    <span className={`mr-1.5 text-xs font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${f.cls}`}>{f.tipo}</span>
                    <span className="font-medium text-gray-900 break-words">{f.titulo}</span>
                  </span>
                  {f.sub && <span className="block text-xs text-gray-600 mt-1 break-words">{f.sub}</span>}
                </span>
                <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">{f.der}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
