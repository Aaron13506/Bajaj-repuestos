import { db } from '@/lib/db'
import Link from 'next/link'
import AprobarPedidoForm from '@/components/AprobarPedidoForm'
import ConfirmarEntregaForm from '@/components/ConfirmarEntregaForm'
import RegistrarPagoClienteForm from '@/components/RegistrarPagoClienteForm'
import RenovarPresupuestoButton from '@/components/RenovarPresupuestoButton'
import { BOTON } from '@/components/clases-boton'
import { aprobarPedido, registrarPagoPedido } from './actions'
import { confirmarEntrega, renovarPresupuesto } from './flujos-actions'
import { isDelivered, isPending, stageSummary } from '@/lib/shipping-status'
import { pedidoLogistics } from '@/lib/pedido-logistics'
import { escalonBcvVigente } from '@/lib/calc'
import { num, toConfigMap } from '@/lib/config'
import { resumenCobro } from '@/lib/cobro-bcv'
import { embudo, escalonDelPresupuesto, estadoValidez, validezDias } from '@/lib/validez'
import { cabeceraDeLinea } from '@/lib/linea-pedido'
import { modeloLabel, toModelIds } from '@/lib/modelo'
import { motivoNoEntregable } from '@/lib/saldo-entrega'
import { mensajeEstado } from '@/lib/mensajes-cliente'
import { METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { telefonoIntl } from '@/lib/utils'
import { ESTADOS_LISTA, PRIORIDAD_LISTA, entregable, estadoLista, etapaVisible, type EstadoLista } from '@/lib/pedido-lista'

export const metadata = { title: 'Presupuestos' }

// Arriba, qué pedidos se miran; dentro de Clientes, en qué estado (lib/pedido-lista.ts).
const VISTAS = [
  { id: 'clientes', label: 'Clientes' },
  { id: 'propio', label: 'Stock propio' },
  { id: 'cerrados', label: 'Cerrados' },
] as const
type Vista = (typeof VISTAS)[number]['id']
type Estado = (typeof ESTADOS_LISTA)[number]['id']

const DIA = 24 * 3600 * 1000
const chip = 'inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap'
const usd = (n: number) => `$${n.toFixed(2)}`

export default async function PresupuestosPage({
  searchParams,
}: {
  searchParams: Promise<{ ver?: string; estado?: string; q?: string }>
}) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ''
  const [todosSinFiltro, configRows] = await Promise.all([
    // Las ventas del depósito tienen su propia sección (/ventas).
    db.pedido.findMany({
      where: { tipo: { not: 'venta' } },
      include: {
        items: {
          include: {
            product: { select: { id: true, nameEs: true, bajajCode: true, compatibleModels: true, imageUrl: true } },
            ensamble: { select: { id: true, nameEs: true, nameEn: true, compatibleModels: true, imageUrl: true } },
            envio: { select: { id: true, nombre: true } },
            incidencias: { select: { tipo: true, estado: true } },
          },
          orderBy: { id: 'asc' },
        },
        cliente: { select: { telefono: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.config.findMany(),
  ])
  const cfg = toConfigMap(configRows)
  const escalonHoy = escalonBcvVigente(cfg)
  const diasValidez = validezDias(cfg)
  const tasaBcv = num(cfg, 'bcv_usd_rate', 0)
  const tasaCobro = num(cfg, 'bsd_usd_rate', 0)
  const ahora = new Date()

  // Busca por cliente o por número ("123" o "#123"); la conversión de abajo usa todos igual.
  const qNum = parseInt(q.replace(/^#/, ''))
  const todos = q
    ? todosSinFiltro.filter(p => p.id === qNum || p.clientName.toLowerCase().includes(q.toLowerCase()))
    : todosSinFiltro

  const propios = todos.filter(p => p.tipo === 'propio')
  const cancelados = todos.filter(p => p.tipo !== 'propio' && p.status === 'cancelado')
  const perdidos = todos.filter(p => p.status === 'presupuesto' && p.perdidoAt)
  const clientes = todos
    .filter(p => p.tipo !== 'propio' && p.status !== 'cancelado' && !p.perdidoAt)
    .map(p => ({ p, estado: estadoLista(p), validez: p.status === 'presupuesto' ? estadoValidez(p, diasValidez) : null }))
  const porEstado = (e: EstadoLista) => clientes.filter(c => c.estado === e)
  // Conversión de los presupuestos de cliente de los últimos 90 días (lib/validez.ts, embudo).
  const conversion = embudo(todosSinFiltro.filter(p => p.tipo === 'cliente'), diasValidez, undefined, 90)

  const conteoVista: Record<Vista, number> = { clientes: clientes.length, propio: propios.length, cerrados: cancelados.length + perdidos.length }
  const conteoEstado = (e: Estado) => (e === 'todo' ? clientes.length : porEstado(e).length)
  // Los enlaces viejos (?ver=abiertos / ?ver=pedidos) caen en Clientes.
  const verPedido = sp.ver === 'abiertos' || sp.ver === 'pedidos' ? 'clientes' : sp.ver
  // Sin vista elegida: Clientes, salvo que buscando no haya nada ahí y sí en otra.
  const ver: Vista = VISTAS.find(v => v.id === verPedido)?.id
    ?? (q ? VISTAS.find(v => conteoVista[v.id] > 0)?.id : undefined)
    ?? 'clientes'
  const estado: Estado = ESTADOS_LISTA.find(e => e.id === sp.estado)?.id ?? (sp.ver === 'abiertos' ? 'presu' : 'todo')
  const href = (v: Vista, e?: Estado) =>
    `/presupuestos?ver=${v}${e && e !== 'todo' ? `&estado=${e}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`

  // Peso y volumen de lo propio, medido en una sola pasada (ver pedido-logistics):
  // por pedido para cada fila, y el total de todo lo que traigo por mi cuenta.
  const { total: propiosTotal, porPedido: logPropios } = await pedidoLogistics(
    ver === 'propio' ? propios.map(p => p.id) : []
  )

  type P = (typeof todos)[number]
  // Los mismos montos que el detalle y el PDF: a dólar BCV con el escalón con que se cotizó
  // (presupuesto) o el congelado al confirmar (pedido). Ver lib/cobro-bcv.ts.
  const montos = (p: P) => {
    const escalon = p.tipo === 'propio'
      ? null
      : p.status === 'presupuesto'
        ? escalonDelPresupuesto(p.escalonCotizadoPct != null ? Number(p.escalonCotizadoPct) : null, escalonHoy)
        : p.brechaEscalonPct != null ? Number(p.brechaEscalonPct) : null
    const depositUsd = p.depositUsd != null ? Number(p.depositUsd) : null
    const cobro = resumenCobro(p.items.map(it => ({ salePrice: Number(it.salePrice), quantity: it.quantity })), depositUsd ?? 0, escalon)
    const modoBcv = escalon != null
    return {
      cobro, depositUsd, modoBcv,
      tasaBs: modoBcv ? { valor: tasaBcv, etiqueta: 'Tasa BCV' } : { valor: tasaCobro, etiqueta: 'Tasa de cobro' },
    }
  }
  const fecha = (d: Date) => d.toLocaleDateString('es-VE', {
    day: '2-digit', month: 'short', timeZone: 'America/Caracas',
    year: d.getFullYear() !== ahora.getFullYear() ? 'numeric' : undefined,
  })
  const hace = (d: Date) => {
    const dias = Math.floor((ahora.getTime() - d.getTime()) / DIA)
    return dias < 1 ? 'hoy' : dias === 1 ? 'ayer' : dias < 31 ? `hace ${dias} d` : `hace ${Math.floor(dias / 30)} m`
  }
  const piezas = (p: P, max = 3) => {
    const ns = p.items.map(it => `${it.quantity > 1 ? `${it.quantity}× ` : ''}${cabeceraDeLinea(it).nameEs}`)
    return ns.slice(0, max).join(', ') + (ns.length > max ? ` y ${ns.length - max} más` : '')
  }
  const motos = (p: P) => modeloLabel([...new Set(p.items.flatMap(it => toModelIds(cabeceraDeLinea(it).compatibleModels)))])?.label ?? null
  const cajas = (p: P) => [...new Map(p.items.filter(it => it.envio).map(it => [it.envio!.id, it.envio!])).values()]
  // Por cliente (o por nombre si no está vinculado): para avisar que tiene otro pedido listo.
  const claveCliente = (p: P) => (p.clienteId != null ? `c${p.clienteId}` : `n${p.clientName.trim().toLowerCase()}`)
  const paraEntregar = porEstado('entregar')

  function Etapa({ p }: { p: P }) {
    const s = stageSummary(p.items)
    if (!s) return null
    const m = etapaVisible(s.allDelivered ? 'entregado' : s.lead.value, p.tipo === 'propio')
    return <span className={`${chip} ${m.badge}`}><span aria-hidden="true">{m.icon}</span> {m.short}</span>
  }

  function Cajas({ p }: { p: P }) {
    const cs = cajas(p)
    // Lo que falta comprar y todavía no tiene caja (sin contar lo servido del depósito ni lo entregado).
    const sinCaja = p.items.filter(it => it.envioId == null && !it.desdeStock && !it.isLanded && !isDelivered(it.shippingStatus)).length
    return (
      <>
        {cs.map(c => (
          <Link key={c.id} href={`/envios/${c.id}`} className="text-gray-600 hover:text-blue-700 hover:underline">
            caja #{c.id}{c.nombre ? ` ${c.nombre}` : ''}
          </Link>
        ))}
        {sinCaja > 0 && p.status === 'pedido' && (
          <span className={p.tipo === 'propio' && cs.length === 0 ? 'text-amber-800 font-medium' : ''}>
            {cs.length === 0 ? (p.tipo === 'propio' ? 'sin caja: no está viajando' : 'sin caja') : `${sinCaja} sin caja`}
          </span>
        )}
      </>
    )
  }

  function Fila({ p, estadoP, validez }: { p: P; estadoP?: EstadoLista; validez?: ReturnType<typeof estadoValidez> | null }) {
    const isPropio = p.tipo === 'propio'
    const isCancelado = p.status === 'cancelado'
    const isPresu = p.status === 'presupuesto'
    const perdido = isPresu && p.perdidoAt != null
    const { cobro, depositUsd, modoBcv, tasaBs } = montos(p)
    const saldo = cobro.saldoBcv
    const abiertas = p.items.flatMap(it => it.incidencias).filter(i => i.estado === 'abierta')
    const noVino = abiertas.filter(i => i.tipo === 'sin_enviar').length
    const otrosProblemas = abiertas.length - noVino
    const otros = estadoP === 'entregar'
      ? paraEntregar.filter(c => c.p.id !== p.id && claveCliente(c.p) === claveCliente(p)).map(c => c.p.id)
      : []
    const puedeEntregar = estadoP === 'entregar' && entregable(p)
    const compra = stageSummary(p.items)
    const tel = telefonoIntl(p.cliente?.telefono)
    const aviso = puedeEntregar && compra
      ? mensajeEstado({
          nombre: p.clientName, pedidoId: p.id, etapa: compra.lead.value, porComprar: compra.pendientes,
          porPagar: { usd: saldo, bcv: modoBcv, bs: modoBcv && tasaBcv > 0 ? saldo * tasaBcv : null, divisas: cobro.saldoReal },
        })
      : null
    const quien = <span className="sr-only"> #{p.id} de {p.clientName}</span>
    const m = motos(p)
    const log = isPropio ? logPropios.get(p.id) : undefined

    return (
      <li className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-xs font-mono text-gray-500">#{p.id}</span>
            <Link href={`/presupuestos/${p.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline break-words">
              {p.clientName}
            </Link>
            {p.via === 'express' && <span className={`${chip} bg-amber-100 text-amber-800`}>⚡ Express</span>}
            <span className="text-xs text-gray-500">
              {isPresu ? 'cotizado ' : ''}{fecha(validez?.desde ?? p.createdAt)} · {hace(validez?.desde ?? p.createdAt)}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-0.5 break-words text-pretty">
            {isPropio && <>{p.items.length} {p.items.length === 1 ? 'línea' : 'líneas'} · {p.items.reduce((s, it) => s + it.quantity, 0)} piezas · </>}
            {piezas(p, isPropio ? 2 : 3)}
            {m && <span className="text-gray-500"> · {m}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-gray-500">
            {isCancelado ? <span className={`${chip} bg-red-100 text-red-700`}>Cancelado</span>
              : perdido ? <span className={`${chip} bg-gray-200 text-gray-700`}>Perdido{p.perdidoMotivo ? `: ${p.perdidoMotivo}` : ''}</span>
              : isPresu ? (
                <>
                  <span className={`${chip} bg-yellow-100 text-yellow-800`}>Presupuesto · sin confirmar</span>
                  {validez && (validez.vencido
                    ? <span className={`${chip} bg-red-100 text-red-700`}>Venció {-validez.diasRestantes <= 1 ? 'ayer' : `hace ${-validez.diasRestantes} d`}</span>
                    : <span className={`${chip} ${validez.diasRestantes <= 2 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>
                        {validez.diasRestantes === 0 ? 'Vence hoy' : `Vence en ${validez.diasRestantes} ${validez.diasRestantes === 1 ? 'día' : 'días'}`}
                      </span>)}
                </>
              ) : <Etapa p={p} />}
            {!isPresu && <Cajas p={p} />}
            {noVino > 0 && <span className={`${chip} bg-red-100 text-red-700`}>⚠ {noVino} no {noVino === 1 ? 'vino' : 'vinieron'}</span>}
            {otrosProblemas > 0 && (
              <span className={`${chip} bg-red-100 text-red-700`}>
                ⚠ {otrosProblemas} {otrosProblemas === 1 ? 'problema abierto' : 'problemas abiertos'}{estadoP === 'entregar' && !puedeEntregar ? ': resolvelo para entregar' : ''}
              </span>
            )}
            {p.origenMotivo && <span>{p.origenMotivo === 'reposicion' ? '↻ reposición' : '↩ sobrante'} de #{p.origenId}</span>}
            {otros.length > 0 && <span className="text-blue-700 font-medium">También tiene #{otros.join(', #')} para entregar</span>}
          </div>
          {p.notas && <p className="text-xs text-gray-500 mt-1 line-clamp-1 break-words" title={p.notas}>{p.notas}</p>}
          {log && log.piezas > 0 && (
            <p className="text-xs text-gray-500 mt-1 font-mono tabular-nums">
              {log.chargeableKg.toFixed(2)} kg · {log.ft3.toFixed(2)} ft³
              {log.incompletas > 0 && <span className="text-amber-700 font-sans"> · {log.incompletas} sin medir</span>}
            </p>
          )}
        </div>

        <div className="text-right shrink-0 min-w-[6.5rem] tabular-nums">
          {isPropio ? (
            <><span className="font-semibold text-gray-900">{usd(cobro.totalBcv)}</span><p className="text-xs text-gray-500">costo</p></>
          ) : isPresu || isCancelado ? (
            <>
              <span className="font-semibold text-gray-900">{usd(cobro.totalBcv)}</span>
              {modoBcv && <span className="ml-1 text-[11px] font-semibold text-gray-500">BCV</span>}
              {isPresu && !perdido && <p className="text-xs text-gray-500">adelanto {usd(Math.round(cobro.totalBcv * 50) / 100)}</p>}
              {isCancelado && depositUsd != null && depositUsd > 0.005 && <p className="text-xs text-red-700">Se quedó {usd(depositUsd)}</p>}
            </>
          ) : (
            <>
              {saldo > 0.005
                ? <span className="font-semibold text-amber-800">Debe {usd(saldo)}</span>
                : saldo < -0.005
                  ? <span className="font-medium text-green-700">A favor {usd(-saldo)}</span>
                  : <span className="font-medium text-green-700">Pagado</span>}
              {modoBcv && <span className="ml-1 text-[11px] font-semibold text-gray-500">BCV</span>}
              <p className="text-xs text-gray-500">de {usd(cobro.totalBcv)}</p>
            </>
          )}
        </div>

        {estadoP && (puedeEntregar || isPresu || (estadoP === 'entregados' && saldo > 0.005)) && (
          <div className="flex flex-wrap gap-2 shrink-0">
            {puedeEntregar && (
              <>
                {/* Sin teléfono, wa.me deja elegir el contacto en WhatsApp. */}
                <a
                  href={`https://wa.me/${tel ?? ''}?text=${encodeURIComponent(aviso ?? '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={BOTON.whatsapp}
                >
                  Avisar<span className="sr-only"> por WhatsApp a {p.clientName}</span>
                </a>
                <ConfirmarEntregaForm
                  action={confirmarEntrega.bind(null, p.id)}
                  lineas={p.items.filter(it => !isDelivered(it.shippingStatus)).map(it => ({
                    id: it.id, nombre: cabeceraDeLinea(it).nameEs, quantity: it.quantity, motivo: motivoNoEntregable(it),
                  }))}
                  methods={METODOS_PAGO_INGRESO}
                  modoBcv={modoBcv}
                  saldo={{ bs: cobro.saldoBcv, divisas: cobro.saldoReal }}
                  tasaBs={tasaBs}
                  tasaDevolucion={tasaCobro}
                  etiqueta={<>Entregar<span className="sr-only"> pedido{quien}</span></>}
                  claseBoton={BOTON.entregar}
                />
              </>
            )}
            {isPresu && (validez?.vencido
              ? <RenovarPresupuestoButton action={renovarPresupuesto.bind(null, p.id)} etiqueta={<>Renovar<span className="sr-only"> presupuesto{quien}</span></>} claseBoton={BOTON.secundario} />
              : (
                <AprobarPedidoForm
                  action={aprobarPedido.bind(null, p.id)}
                  methods={METODOS_PAGO_INGRESO}
                  montos={{ bs: Math.round(cobro.totalBcv * 50) / 100, divisas: Math.round(cobro.totalReal * 50) / 100 }}
                  modoBcv={modoBcv}
                  tasaBs={tasaBs}
                  etiqueta={<>Confirmar<span className="sr-only"> presupuesto{quien}</span></>}
                  claseBoton={BOTON.primario}
                />
              ))}
            {estadoP === 'entregados' && saldo > 0.005 && (
              <RegistrarPagoClienteForm
                action={registrarPagoPedido.bind(null, p.id)}
                methods={METODOS_PAGO_INGRESO}
                modoBcv={modoBcv}
                tasaBs={tasaBs}
                saldo={{ bs: cobro.saldoBcv, divisas: cobro.saldoReal }}
                etiqueta={<>Cobrar<span className="sr-only"> saldo{quien}</span></>}
                claseBoton={BOTON.secundario}
              />
            )}
          </div>
        )}
      </li>
    )
  }

  const Lista = ({ children, etiqueta }: { children: React.ReactNode; etiqueta: string }) => (
    <ul aria-label={etiqueta} className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100 overflow-hidden">{children}</ul>
  )
  const Seccion = ({ titulo, cuenta, nota, tono = 'text-gray-800', children }: {
    titulo: string; cuenta: number; nota?: React.ReactNode; tono?: string; children: React.ReactNode
  }) => (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={`text-base font-semibold text-balance ${tono}`}>{titulo} <span className="tabular-nums text-gray-500 font-normal">{cuenta}</span></h2>
        {nota && <p className="text-sm text-gray-600">{nota}</p>}
      </div>
      <Lista etiqueta={titulo}>{children}</Lista>
    </section>
  )

  // ── Clientes: lo que me toca hacer, por estado ──────────────────────────────
  function vistaClientes() {
    const filas = (estado === 'todo' ? clientes : porEstado(estado)).slice().sort((a, b) =>
      PRIORIDAD_LISTA[a.estado] - PRIORIDAD_LISTA[b.estado]
      || (a.estado === 'presu' ? (a.validez?.diasRestantes ?? 0) - (b.validez?.diasRestantes ?? 0)
        // Lo entregado, lo último arriba; lo demás, el que más espera primero.
        : a.estado === 'entregados' ? b.p.createdAt.getTime() - a.p.createdAt.getTime()
        : a.p.createdAt.getTime() - b.p.createdAt.getTime()))
    const cobrar = paraEntregar.reduce((s, c) => s + Math.max(0, montos(c.p).cobro.saldoBcv), 0)
    const piezasPorComprar = porEstado('comprar').concat(paraEntregar, porEstado('camino'))
      .reduce((s, c) => s + c.p.items.filter(it => isPending(it.shippingStatus)).reduce((n, it) => n + it.quantity, 0), 0)
    const presus = porEstado('presu')
    const conSaldo = porEstado('entregados').filter(c => montos(c.p).cobro.saldoBcv > 0.005).length
    const B = ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-gray-900 tabular-nums">{children}</strong>
    const irAComprar = <Link href="/contabilidad/comprar" className="font-medium text-blue-700 hover:underline">Ir a Por comprar →</Link>
    const resumen: Record<Estado, React.ReactNode> = {
      todo: <><B>{paraEntregar.length}</B> para entregar (<B>{usd(cobrar)}</B> por cobrar) · <B>{presus.length}</B> {presus.length === 1 ? 'presupuesto' : 'presupuestos'} sin confirmar · <B>{piezasPorComprar}</B> piezas por comprar</>,
      entregar: <><B>{usd(cobrar)}</B> por cobrar al entregar · el que más espera, primero</>,
      presu: (
        <>
          Sin confirmar: no se compran ni cuentan como venta hasta el adelanto del 50%. El que vence antes, primero.
          {conversion.total > 0 && (
            <span className="block text-xs text-gray-500 mt-0.5">
              Últimos 90 días: {conversion.total} presupuestos · {conversion.confirmados} confirmados · {conversion.perdidos} perdidos · {conversion.vencidos} vencidos sin respuesta · {conversion.abiertos} abiertos
              {conversion.conversionPct != null && <> · <span className="font-semibold text-gray-700">{conversion.conversionPct.toFixed(0)}% de conversión</span> (sobre los que ya se decidieron)</>}
            </span>
          )}
        </>
      ),
      camino: 'Comprado y viajando: avanza solo cuando avanza su caja.',
      comprar: <><B>{piezasPorComprar}</B> piezas por comprar · {irAComprar}</>,
      entregados: conSaldo > 0 ? <><B>{conSaldo}</B> se {conSaldo === 1 ? 'llevó' : 'llevaron'} las piezas debiendo</> : 'Todo cobrado.',
    }
    const vacio: Record<Estado, React.ReactNode> = {
      todo: q ? `Ningún pedido de cliente coincide con "${q}".` : <>Todavía no hay pedidos de clientes. <Link href="/presupuestos/new" className="font-medium text-blue-700 hover:underline">Crear un presupuesto</Link></>,
      entregar: 'Nada para entregar. Cuando llegue una caja, sus pedidos aparecen acá.',
      presu: <>No hay presupuestos sin confirmar. <Link href="/presupuestos/new" className="font-medium text-blue-700 hover:underline">Crear un presupuesto</Link></>,
      camino: 'Nada viajando.',
      comprar: 'Nada por comprar.',
      entregados: 'Todavía no se entregó nada.',
    }
    const etiqueta = ESTADOS_LISTA.find(e => e.id === estado)!.label
    return (
      <>
        <nav aria-label="Filtrar clientes por estado" className="flex items-end gap-1 overflow-x-auto max-w-full mb-3 border-b border-gray-200">
          {ESTADOS_LISTA.map(e => {
            const n = conteoEstado(e.id)
            const activo = estado === e.id
            const resalta = n > 0 && (e.id === 'entregar' ? 'bg-green-100 text-green-800 font-semibold' : e.id === 'presu' ? 'bg-yellow-100 text-yellow-800 font-semibold' : null)
            return (
              <Link
                key={e.id}
                href={href('clientes', e.id)}
                aria-current={activo ? 'page' : undefined}
                className={`shrink-0 inline-flex items-center gap-1.5 min-h-11 px-3 text-sm -mb-px border-b-2 whitespace-nowrap ${
                  activo ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                {e.label}
                <span className={`text-xs tabular-nums px-1.5 rounded-full ${resalta || 'bg-gray-100 text-gray-600'}`}>{n}</span>
              </Link>
            )
          })}
        </nav>
        <p className="text-sm text-gray-600 mb-3 text-pretty">{resumen[estado]}</p>
        {filas.length > 0
          ? <Lista etiqueta={etiqueta}>{filas.map(c => <Fila key={c.p.id} p={c.p} estadoP={c.estado} validez={c.validez} />)}</Lista>
          : <p className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">{vacio[estado]}</p>}
      </>
    )
  }

  // ── Stock propio: termina en el depósito ─────────────────────────────────────
  function vistaPropio() {
    const enDeposito = propios.filter(p => p.items.length > 0 && p.items.every(it => isDelivered(it.shippingStatus)))
    const enCurso = propios.filter(p => !enDeposito.includes(p))
    if (propios.length === 0) {
      return (
        <p className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">
          {q ? `Nada de stock propio coincide con "${q}".` : <>Todavía no trajiste stock propio. <Link href="/presupuestos/new?tipo=propio" className="font-medium text-blue-700 hover:underline">Armar uno</Link></>}
        </p>
      )
    }
    return (
      <div className="space-y-6">
        <div className="text-sm text-gray-600 space-y-1">
          <p>Lo que traigo para el depósito. Termina en <strong className="font-semibold text-gray-900">En depósito</strong>, no en «entregado».</p>
          {propiosTotal.piezas > 0 && (
            <p className="text-xs text-gray-500">
              <span className="font-mono font-semibold text-gray-700 tabular-nums">{propiosTotal.chargeableKg.toFixed(2)} kg</span> cobrables ·{' '}
              <span className="font-mono font-semibold text-gray-700 tabular-nums">{propiosTotal.ft3.toFixed(2)} ft³</span>{' '}
              ({propiosTotal.realKg.toFixed(2)} kg reales{propiosTotal.incompletas > 0 && `, ${propiosTotal.incompletas} piezas sin medir`})
            </p>
          )}
        </div>
        {enCurso.length > 0 && (
          <Seccion titulo="Por comprar o viajando" cuenta={enCurso.length}>
            {enCurso.map(p => <Fila key={p.id} p={p} />)}
          </Seccion>
        )}
        {enDeposito.length > 0 && (
          <Seccion titulo="En depósito" cuenta={enDeposito.length} nota="ya suman al inventario" tono="text-green-800">
            {enDeposito.map(p => <Fila key={p.id} p={p} />)}
          </Seccion>
        )}
      </div>
    )
  }

  // ── Cerrados: lo que no siguió, para que cuente en la conversión ─────────────
  function vistaCerrados() {
    if (cancelados.length + perdidos.length === 0) {
      return (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
          <p className="font-medium text-gray-700">{q ? `Nada cerrado coincide con "${q}".` : 'Nada cancelado ni perdido'}</p>
          {!q && <p className="text-sm mt-1 text-pretty">Cuando un cliente diga que no o se cancele un pedido, queda acá para contar en la conversión.</p>}
        </div>
      )
    }
    return (
      <div className="space-y-6">
        {cancelados.length > 0 && <Seccion titulo="Cancelados" cuenta={cancelados.length}>{cancelados.map(p => <Fila key={p.id} p={p} />)}</Seccion>}
        {perdidos.length > 0 && <Seccion titulo="Perdidos" cuenta={perdidos.length}>{perdidos.map(p => <Fila key={p.id} p={p} />)}</Seccion>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Presupuestos y pedidos</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/presupuestos/new?tipo=propio" className={BOTON.secundario}>+ Stock propio</Link>
          <Link href="/presupuestos/new?via=express" className={BOTON.secundario}>+ Express</Link>
          <Link href="/presupuestos/new" className={BOTON.primario}>+ Nuevo presupuesto</Link>
        </div>
      </div>

      {todosSinFiltro.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center text-gray-500">
          <p className="text-lg">Sin presupuestos</p>
          <p className="text-sm mt-1">
            <Link href="/presupuestos/new" className="text-blue-700 hover:underline">Crear el primer presupuesto</Link>
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <nav aria-label="Qué pedidos ver" className="inline-flex rounded-lg border border-gray-200 bg-white p-1 gap-1">
              {VISTAS.map(v => (
                <Link
                  key={v.id}
                  href={href(v.id)}
                  aria-current={ver === v.id ? 'page' : undefined}
                  className={`inline-flex items-center gap-1.5 min-h-9 px-3 rounded-md text-sm ${
                    ver === v.id ? 'bg-gray-900 text-white font-semibold' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {v.label}
                  <span className={`tabular-nums ${ver === v.id ? 'text-gray-300' : 'text-gray-500'}`}>{conteoVista[v.id]}</span>
                </Link>
              ))}
            </nav>
            <form role="search" className="flex items-center gap-2 w-full sm:w-auto">
              <input type="hidden" name="ver" value={ver} />
              {ver === 'clientes' && estado !== 'todo' && <input type="hidden" name="estado" value={estado} />}
              <label htmlFor="buscar-pedido" className="sr-only">Buscar por cliente o número</label>
              <input
                id="buscar-pedido"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Cliente o #número…"
                className="w-full sm:w-56 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {q && <Link href={href(ver, ver === 'clientes' ? estado : undefined).replace(/&q=[^&]*/, '')} className="text-sm text-gray-600 hover:text-gray-900 min-h-9 inline-flex items-center px-1">Limpiar</Link>}
            </form>
          </div>
          {ver === 'clientes' ? vistaClientes() : ver === 'propio' ? vistaPropio() : vistaCerrados()}
        </>
      )}
    </div>
  )
}
