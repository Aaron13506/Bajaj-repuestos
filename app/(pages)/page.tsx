import { db } from '@/lib/db'
import Link from 'next/link'
import { resumenInventario } from '@/lib/inventario'
import { cuentasPorPagar } from '@/lib/movimientos'
import { toConfigMap } from '@/lib/config'
import { saldoReal, situacionDeCobro, debeSaldo, SITUACION_LABELS } from '@/lib/saldo-entrega'
import { estadoValidez, validezDias } from '@/lib/validez'
import { DIAS_CAJA_PARADA, diasSinMoverse } from '@/lib/etapas'
import { VENTA_STATUS } from '@/lib/clientes'

// Panel de acción: lo que hay que hacer hoy, no conteos del catálogo (revisión de negocio 3.2).
// "Stock bajo" sobre miles de piezas en cero en un negocio por encargo era ruido.

const usd = (n: number) => `$${n.toFixed(2)}`
const dec = (v: { toString(): string } | null) => (v != null ? parseFloat(v.toString()) : null)
// Presupuestos que vencen en estos días o menos: hay que llamar al cliente antes.
const DIAS_AVISO_VENCE = 2

async function getDatos() {
  // Todo independiente: una sola tanda, la latencia se paga una vez.
  const [cfgRows, pedidos, porComprar, sinCaja, cajas, abiertos, cuentas, inventario] = await Promise.all([
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
      where: { modo: 'aereo', estado: { not: 'borrador' } },
      select: {
        id: true, nombre: true, supplier: { select: { name: true } },
        items: { select: { shippingStatus: true, shippingStatusAt: true } },
      },
    }),
    db.pedido.findMany({
      where: { tipo: 'cliente', status: 'presupuesto', perdidoAt: null },
      select: { id: true, clientName: true, createdAt: true, cotizadoAt: true },
    }),
    cuentasPorPagar(),
    resumenInventario(),
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
    .map(c => ({ id: c.id, nombre: c.nombre ?? `Caja #${c.id}`, proveedor: c.supplier?.name ?? null, dias: diasSinMoverse(c.items) }))
    .filter((c): c is typeof c & { dias: number } => c.dias != null && c.dias >= DIAS_CAJA_PARADA)
    .sort((a, b) => b.dias - a.dias)

  const dias = validezDias(cfg)
  const vigencias = abiertos.map(p => ({ ...p, v: estadoValidez(p, dias) }))
  const porVencer = vigencias.filter(p => !p.v.vencido && p.v.diasRestantes <= DIAS_AVISO_VENCE).sort((a, b) => a.v.diasRestantes - b.v.diasRestantes)
  const vencidos = vigencias.filter(p => p.v.vencido).length

  const deuda = cuentas.pendientes.reduce((s, e) => s + Math.max(0, e.pendiente), 0)

  return {
    entregadoSinPagar, paradas, porVencer, vencidos, deuda, cuentas, inventario,
    porComprar: { lineas: porComprar.reduce((s, g) => s + g._count._all, 0), pedidos: porComprar.length, sinCaja },
  }
}

export default async function DashboardPage() {
  const d = await getDatos()
  const totalSinPagar = d.entregadoSinPagar.reduce((s, p) => s + p.saldo, 0)

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Para hacer hoy</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Tarjeta
          href="/contabilidad"
          titulo="Entregado sin pagar"
          valor={usd(totalSinPagar)}
          detalle={`${d.entregadoSinPagar.length} pedido(s): ya se llevaron la pieza`}
          alerta={d.entregadoSinPagar.length > 0}
        />
        <Tarjeta
          href="/contabilidad/comprar"
          titulo="Por comprar"
          valor={`${d.porComprar.lineas} líneas`}
          detalle={`en ${d.porComprar.pedidos} pedido(s)${d.porComprar.sinCaja > 0 ? ` · ${d.porComprar.sinCaja} sin caja` : ''}`}
          alerta={d.porComprar.lineas > 0}
        />
        <Tarjeta
          href="/contabilidad"
          titulo="Deuda con proveedores"
          valor={usd(d.deuda)}
          detalle={`${d.cuentas.pendientes.length} caja(s) por pagar${d.cuentas.sobrepagadas.length > 0 ? ` · ${d.cuentas.sobrepagadas.length} sobrepagada(s)` : ''}`}
          alerta={d.cuentas.sobrepagadas.length > 0}
        />
        <Tarjeta
          href="/inventario"
          titulo="Inventario"
          valor={usd(d.inventario.aqui.valorUsd + d.inventario.camino.valorUsd)}
          detalle={`${usd(d.inventario.aqui.valorUsd)} aquí + ${usd(d.inventario.camino.valorUsd)} en camino`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Lista titulo="Cobrar: entregado sin pagar" vacio="Nadie se llevó piezas sin pagar.">
          {d.entregadoSinPagar.slice(0, 8).map(p => (
            <Fila key={p.id} href={`/presupuestos/${p.id}`} izq={`#${p.id} ${p.clientName}`} sub={SITUACION_LABELS[p.situacion]} der={usd(p.saldo)} />
          ))}
        </Lista>

        <Lista titulo={`Cajas paradas (${DIAS_CAJA_PARADA}+ días sin moverse)`} vacio="Todas las cajas se movieron hace poco.">
          {d.paradas.slice(0, 8).map(c => (
            <Fila key={c.id} href={`/envios/${c.id}`} izq={c.nombre} sub={c.proveedor ?? undefined} der={`${c.dias} días`} />
          ))}
        </Lista>

        <Lista
          titulo="Presupuestos por vencer"
          vacio="Ninguno vence en los próximos días."
          pie={d.vencidos > 0 ? <Link href="/presupuestos" className="text-xs text-red-600 hover:underline">{d.vencidos} vencido(s) sin respuesta: renovar o marcar perdido</Link> : null}
        >
          {d.porVencer.slice(0, 8).map(p => (
            <Fila
              key={p.id}
              href={`/presupuestos/${p.id}`}
              izq={`#${p.id} ${p.clientName}`}
              der={p.v.diasRestantes === 0 ? 'vence hoy' : `${p.v.diasRestantes} día(s)`}
            />
          ))}
        </Lista>
      </div>
    </div>
  )
}

function Tarjeta({ href, titulo, valor, detalle, alerta = false }: {
  href: string; titulo: string; valor: string; detalle: string; alerta?: boolean
}) {
  return (
    <Link href={href} className={`block bg-white rounded-xl p-5 shadow-sm border hover:shadow ${alerta ? 'border-amber-200' : 'border-gray-100'}`}>
      <p className="text-sm text-gray-500">{titulo}</p>
      <p className={`text-2xl font-bold mt-1 font-mono ${alerta ? 'text-amber-700' : 'text-gray-900'}`}>{valor}</p>
      <p className="text-xs text-gray-400 mt-1">{detalle}</p>
    </Link>
  )
}

function Lista({ titulo, vacio, pie, children }: {
  titulo: string; vacio: string; pie?: React.ReactNode; children: React.ReactNode[]
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h2 className="font-semibold text-gray-900 mb-3 text-sm">{titulo}</h2>
      {children.length === 0 ? <p className="text-sm text-gray-400 py-2">{vacio}</p> : <div className="divide-y divide-gray-50">{children}</div>}
      {pie && <div className="mt-3">{pie}</div>}
    </div>
  )
}

function Fila({ href, izq, sub, der }: { href: string; izq: string; sub?: string; der: string }) {
  return (
    <Link href={href} className="flex items-center justify-between py-2 hover:bg-gray-50 -mx-2 px-2 rounded">
      <span className="min-w-0">
        <span className="block text-sm text-gray-800 truncate">{izq}</span>
        {sub && <span className="block text-xs text-gray-400">{sub}</span>}
      </span>
      <span className="text-sm font-mono text-gray-700 shrink-0 ml-3">{der}</span>
    </Link>
  )
}
