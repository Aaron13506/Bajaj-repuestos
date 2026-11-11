import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import PresupuestoPdfButton from '@/components/PresupuestoPdfButton'
import AprobarPedidoForm from '@/components/AprobarPedidoForm'
import RegistrarPagoClienteForm from '@/components/RegistrarPagoClienteForm'
import MedidasIA, { type GrupoMedidas, type PiezaMedible } from '@/components/MedidasIA'
import CancelarPedidoForm from '@/components/CancelarPedidoForm'
import DevolverClienteForm from '@/components/DevolverClienteForm'
import RenovarPresupuestoButton from '@/components/RenovarPresupuestoButton'
import IncidenciasLinea, { type IncidenciaVista } from '@/components/IncidenciasLinea'
import LineaDeposito from '@/components/LineaDeposito'
import ConfirmarEntregaForm, { type LineaEntrega } from '@/components/ConfirmarEntregaForm'
import { motivoNoServible } from '@/lib/venta-stock'
import { deletePresupuesto, aprobarPedido, registrarPagoPedido } from '../actions'
import {
  cancelarPedido, confirmarEntrega, devolverAlCliente, devolverAlDeposito, marcarPerdido, servirDesdeStock, reabrirPresupuesto, renovarPresupuesto, reportarIncidencia,
  resolverIncidencia,
} from '../flujos-actions'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import { anularVenta } from '../../ventas/actions'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import { lookupDeConjuntos } from '@/lib/envio-build'
import { escalonBcvVigente, type ConfigMap } from '@/lib/calc'
import { aDolarBcv, resumenCobro } from '@/lib/cobro-bcv'
import { getTerminos } from '@/lib/terminos'
import { METODOS_PAGO_EGRESO, METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { compararNombre, telefonoIntl, toFileName } from '@/lib/utils'
import type { PresupuestoPdfData } from '@/lib/pdf/presupuesto-pdf'
import { isDelivered, stageSummary, statusIndex } from '@/lib/shipping-status'
import { etapaVisible } from '@/lib/pedido-lista'
import MenuMas from '@/components/MenuMas'
import { BOTON, ITEM_MENU, ITEM_MENU_PELIGRO } from '@/components/clases-boton'
import { modeloLabel, type MotoModelId, toModelIds } from '@/lib/modelo'
import { pedidoLogistics } from '@/lib/pedido-logistics'
import { num, toConfigMap } from '@/lib/config'
import { motivoNoEliminable } from '@/lib/pedido-eliminable'
import { cabeceraDeLinea } from '@/lib/linea-pedido'
import { cargarMargenes } from '@/lib/resultados'
import { estadoValidez, escalonDelPresupuesto, validezDias } from '@/lib/validez'
import { devolucionSugerida, motivoNoCancelable, resumenCancelacion } from '@/lib/pedido-cancelacion'
import { estadoLinea } from '@/lib/pedido-edicion'
import { etiquetaPieza, tiposPara, tiposParaPropio, TIPO_LABELS } from '@/lib/incidencias'
import { motivoNoEntregable, saldoReal } from '@/lib/saldo-entrega'
import { mensajeEstado } from '@/lib/mensajes-cliente'
import { motivoExpressNoAprobable, plazoExpress } from '@/lib/express'
import { expressDelPedido } from '@/lib/express-pedido'

// "#123 Andry" en la pestaña del navegador; lo reexportan las dos rutas del detalle.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  const p = isNaN(id) ? null : await db.pedido.findUnique({ where: { id }, select: { clientName: true } })
  return { title: p ? `#${id} ${p.clientName}` : `#${id}` }
}

// El detalle de un pedido, sea presupuesto/pedido (/presupuestos/[id]) o venta del depósito
// (/ventas/[id]): la venta vive aparte en la navegación, pero es el mismo Pedido por dentro.
export default async function DetallePedido({ params, ruta }: { params: Promise<{ id: string }>; ruta: 'presupuestos' | 'ventas' }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [presupuesto, configRows] = await Promise.all([
    db.pedido.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, nameEs: true, nameEn: true, bajajCode: true, description: true,
                imageUrl: true, compatibleModels: true, weightGrams: true,
                dimL: true, dimA: true, dimH: true, priceInr: true, medidoAt: true,
                stock: true, landedCostUsd: true,
              },
            },
            ensamble: { select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true } },
            supplier: { select: { name: true } },
            envio: { select: { id: true, nombre: true } },
            // Por qué etapas pasó la línea. Los trackings NO van acá: una caja grande tiene varios
            // locales e internacionales y no se sabe cuál lleva qué pieza; se ven en la caja.
            etapas: { select: { desde: true, hacia: true, at: true }, orderBy: { at: 'asc' } },
          },
          orderBy: { id: 'asc' },
        },
        incidencias: { orderBy: { id: 'asc' } },
        eventos: { orderBy: { createdAt: 'desc' } },
        origen: { select: { id: true, clientName: true } },
        cliente: { select: { telefono: true } },
        derivados: { select: { id: true, origenMotivo: true }, orderBy: { id: 'asc' } },
        _count: { select: { movimientos: true } },
        // Cobros y devoluciones del cliente, uno por uno: en Bs se ve lo que entró de verdad.
        movimientos: {
          where: { categoria: { in: ['adelanto_cliente', 'pago_cliente', 'devolucion_cliente'] } },
          select: { id: true, categoria: true, fecha: true, monto: true, montoBs: true, metodoPago: true },
          orderBy: [{ fecha: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    db.config.findMany(),
  ])

  if (!presupuesto) notFound()

  const cfg = toConfigMap(configRows)
  const bsdRow = configRows.find(r => r.key === 'bsd_usd_rate') ?? null

  // Las piezas se listan alfabéticamente (mismo criterio que el builder, ver
  // compararNombre): el orden de carga no le dice nada a quien lee el presupuesto.
  // `cab` es lo que se muestra de la línea, sea pieza suelta o conjunto (ver cabeceraDeLinea).
  const items = presupuesto.items
    .map(it => ({ ...it, cab: cabeceraDeLinea(it) }))
    .sort((a, b) => compararNombre(a.cab.nameEs, b.cab.nameEs))

  const isPropio = presupuesto.tipo === 'propio'
  // Una venta del depósito: nació confirmada y entregada, sin compra ni caja (ver lib/venta-stock).
  const isVenta = presupuesto.tipo === 'venta'
  // Los enlaces viejos (cliente, contabilidad, resultados) apuntan a /presupuestos/[id]: cada uno a su sección.
  if (isVenta !== (ruta === 'ventas')) redirect(isVenta ? `/ventas/${id}` : `/presupuestos/${id}`)
  const isPresupuesto = presupuesto.status === 'presupuesto'
  // Cancelado: ya no se mueve nada. Conserva lo cobrado que no se devolvió (ver cancelarPedido).
  const isCancelado = presupuesto.status === 'cancelado'
  const isConfirmadoCliente = presupuesto.tipo === 'cliente' && presupuesto.status === 'pedido'
  // Un pedido con cobros, compras o piezas en una caja no se borra (ver motivoNoEliminable).
  const noEliminable = motivoNoEliminable({ ...presupuesto, movimientos: presupuesto._count.movimientos })
  const terminos = await getTerminos(presupuesto.status)
  // Peso y volumen: solo en el stock propio. En un presupuesto de cliente el flete ya
  // está adentro del precio y el dato no le dice nada a nadie; en lo mío es la pregunta
  // (cuánto espacio y cuánto peso me como en la caja y después en el depósito).
  const logistica = isPropio ? (await pedidoLogistics([id])).porPedido.get(id) ?? null : null
  const total = presupuesto.items.reduce(
    (sum, item) => sum + parseFloat(item.salePrice.toString()) * item.quantity,
    0
  )

  // Progreso de compra agregado desde los ítems (ver lib/shipping-status.ts).
  const compra = isCancelado ? null : stageSummary(presupuesto.items)
  // Cuánto se gana con este pedido: solo cuando ya es una venta (un presupuesto todavía no).
  const margen = !isPropio && !isPresupuesto ? (await cargarMargenes([id]))[0]?.margen ?? null : null
  // Express: el paquete contra el tope y el margen estimado sobre su landed, con las tarifas de
  // hoy. Es lo que el armador mostró al cotizar, y lo que se revisa al confirmar.
  const express = await expressDelPedido(db, id, cfg)
  const motivoExpress = express && isPresupuesto ? motivoExpressNoAprobable(express) : null

  // ── Volumen y costo por mar ────────────────────────────────────────────────
  // El presupuesto es donde se decide el precio, así que es donde tiene que verse el
  // landed: cuánto m³ compromete cada línea y cuánto flete arrastra. Los conjuntos se
  // expanden a sus piezas reales (un ensamble ocupa lo que ocupan sus piezas).
  const lookup = await lookupDeConjuntos(presupuesto.items.map(it => it.bundleItems as BundlePiece[] | null))

  // Grupos para la carga de medidas: UN GRUPO POR ENSAMBLE. Las piezas de un conjunto se
  // investigan juntas (son de la misma familia y tamaño); las piezas sueltas del
  // presupuesto van todas a un grupo aparte. Es el tamaño de tanda que la IA maneja bien.
  const grupos: GrupoMedidas[] = []
  const sueltas: PiezaMedible[] = []
  const comoPieza = (p: {
    id: number; bajajCode: string | null; nameEs: string; nameEn?: string | null
    compatibleModels?: string | null; weightGrams: number | null
    dimL: number | null; dimA: number | null; dimH: number | null; medidoAt?: Date | null
  }, quantity: number): PiezaMedible => ({
    id: p.id,
    bajajCode: p.bajajCode,
    nameEs: p.nameEs,
    nameEn: p.nameEn ?? null,
    compatibleModels: p.compatibleModels ?? null,
    quantity,
    weightGrams: p.weightGrams,
    dimL: p.dimL,
    dimA: p.dimA,
    dimH: p.dimH,
    medido: p.medidoAt != null,
  })

  for (const it of presupuesto.items) {
    const piezasBundle = (it.bundleItems as BundlePiece[] | null) ?? []
    if (piezasBundle.length === 0) {
      if (it.product) sueltas.push(comoPieza(it.product, it.quantity))
      continue
    }
    // Solo las piezas que resolvieron contra el catálogo: a las que no matchearon por SKU
    // no hay producto al que cargarle la medida.
    const piezas = piezasBundle
      .map(bp => {
        const resuelto = lookup(bp.bajajCode, bp.nameEs)
        return resuelto ? comoPieza(resuelto, bp.quantity * it.quantity) : null
      })
      .filter((p): p is PiezaMedible => p != null)
    if (piezas.length > 0) {
      grupos.push({
        key: `item-${it.id}`,
        titulo: cabeceraDeLinea(it).nameEs,
        subtitulo: null,
        piezas,
      })
    }
  }
  if (sueltas.length > 0) {
    grupos.push({ key: 'sueltas', titulo: 'Piezas sueltas', piezas: sueltas })
  }


  // Un presupuesto o pedido de cliente se muestra a "dólar BCV" (ver lib/cobro-bcv.ts): cada
  // precio unitario es el real dividido entre (1 − escalón de brecha), así unitario ×
  // cantidad = subtotal y la tabla cuadra al centavo. Lo guardado sigue en dólares reales. El
  // presupuesto usa el escalón de hoy; el pedido, el que se congeló al confirmarlo (null = un
  // pedido en dólares reales, anterior al cobro a BCV). Sin tasa BCV cargada se cae a dólares
  // reales y NO se rotula como BCV, en vez de afirmar algo falso.
  const tasaBcv = num(cfg, 'bcv_usd_rate', 0)
  // Un presupuesto se presenta con el escalón con que se cotizó (el del PDF que vio el cliente) y no con el
  // de hoy: es el que se congela al confirmarlo. Uno anterior a esto, sin escalón guardado, usa el de hoy.
  const escalon = isPropio
    ? null
    : isPresupuesto
      ? escalonDelPresupuesto(
          presupuesto.escalonCotizadoPct != null ? Number(presupuesto.escalonCotizadoPct) : null,
          escalonBcvVigente(cfg),
        )
      : presupuesto.brechaEscalonPct != null ? Number(presupuesto.brechaEscalonPct) : null
  const modoBcv = escalon != null
  // La tasa con la que se anotan los Bs de un cobro: la BCV si el pedido es a BCV, y si no la de
  // cobro directo.
  const tasaBsCobro = modoBcv
    ? { valor: tasaBcv, etiqueta: 'Tasa BCV' }
    : { valor: num(cfg, 'bsd_usd_rate', 0), etiqueta: 'Tasa de cobro' }
  const aBcv = (usd: number) => (escalon != null ? aDolarBcv(usd, escalon) : usd)
  // El descuento por divisas ES el escalón: pagar en divisas devuelve exactamente el real.
  const descuentoDivisasPct = escalon ?? 0

  // Adelanto ya registrado (pedido de cliente confirmado): depositUsd está en reales.
  const depositUsd = presupuesto.depositUsd != null ? parseFloat(presupuesto.depositUsd.toString()) : null
  const cobro = resumenCobro(
    presupuesto.items.map(it => ({ salePrice: parseFloat(it.salePrice.toString()), quantity: it.quantity })),
    depositUsd ?? 0,
    escalon,
  )
  const totalMostrado = cobro.totalBcv
  // El cliente tiene de más cuando se editó el pedido a la baja: se le devuelve (o se aplica a otra cosa).
  const saldoAFavor = isConfirmadoCliente ? Math.max(0, -saldoReal(
    presupuesto.items.map(it => ({ salePrice: parseFloat(it.salePrice.toString()), quantity: it.quantity })),
    depositUsd,
  )) : 0
  const tasaDevolucion = num(cfg, 'bsd_usd_rate', 0)
  // Pedido de cliente en curso: el WhatsApp lleva escrito cómo va, y al llegar, lo que falta pagar.
  const tel = telefonoIntl(presupuesto.cliente?.telefono)
  const avisoEstado = isConfirmadoCliente && compra
    ? mensajeEstado({
        nombre: presupuesto.clientName,
        pedidoId: id,
        etapa: compra.lead.value,
        porComprar: compra.pendientes,
        porPagar: { usd: cobro.saldoBcv, bcv: modoBcv, bs: modoBcv && tasaBcv > 0 ? cobro.saldoBcv * tasaBcv : null, divisas: cobro.saldoReal },
      })
    : null
  // Lo que falta entregar, con por qué no se puede todavía (las mismas reglas que confirmarEntrega).
  const porEntregar: LineaEntrega[] = isConfirmadoCliente
    ? items.filter(it => !isDelivered(it.shippingStatus)).map(it => ({
        id: it.id, nombre: it.cab.nameEs, quantity: it.quantity,
        motivo: motivoNoEntregable({ shippingStatus: it.shippingStatus, incidencias: presupuesto.incidencias.filter(i => i.itemId === it.id) }),
      }))
    : []
  const resumenCancel = resumenCancelacion(presupuesto.items.map(it => ({
    shippingStatus: it.shippingStatus, costRealUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null,
  })))
  const noCancelable = motivoNoCancelable({
    tipo: presupuesto.tipo, status: presupuesto.status,
    items: presupuesto.items.map(it => ({ shippingStatus: it.shippingStatus, costRealUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null, desdeStock: it.desdeStock })),
  })
  const totalRealPedido = presupuesto.items.reduce((sum, it) => sum + parseFloat(it.salePrice.toString()) * it.quantity, 0)
  const incidenciasDe = (itemId: number): IncidenciaVista[] =>
    presupuesto.incidencias.filter(i => i.itemId === itemId).map(i => ({
      id: i.id, tipo: i.tipo as IncidenciaVista['tipo'], origen: i.origen as IncidenciaVista['origen'],
      cantidad: i.cantidad, nota: i.nota, estado: i.estado as IncidenciaVista['estado'],
      resolucion: i.resolucion as IncidenciaVista['resolucion'],
      perdidaUsd: i.perdidaUsd != null ? Number(i.perdidaUsd) : null, reposicionId: i.reposicionId, creadaAt: i.creadaAt.toISOString(),
      pieza: i.pieza,
    }))
  // Problemas de líneas que ya no están (se reembolsaron enteras): quedan para que se vea dónde se perdió plata.
  const incidenciasSinLinea = presupuesto.incidencias.filter(i => i.itemId == null)

  const bsdRate = bsdRow ? parseFloat(bsdRow.value) : NaN
  // A dólar BCV no se muestra equivalente en Bs: la tasa del día no es la del pago y confunde.
  const totalBsd = modoBcv || Number.isNaN(bsdRate) ? null : total * bsdRate
  // Abono sugerido: 50% en las dos monedas en que se puede cobrar (el form elige según el método).
  const deposit = Math.round(cobro.totalBcv * 50) / 100
  const depositDivisas = Math.round(cobro.totalReal * 50) / 100
  const depositDateStr = presupuesto.depositAt
    ? new Date(presupuesto.depositAt).toISOString().slice(0, 10)
    : null

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Caracas' })
  // Validez: corre desde la última vez que se cotizó o renovó (ver lib/validez.ts).
  const vigencia = estadoValidez(presupuesto, validezDias(cfg))
  const perdido = isPresupuesto && presupuesto.perdidoAt != null
  const vencido = isPresupuesto && presupuesto.tipo === 'cliente' && vigencia.vencido && !perdido
  const fecha = fmtDate(vigencia.desde)
  const validez = fmtDate(vigencia.venceEl)
  const numero = `N.º ${String(presupuesto.id).padStart(4, '0')}`
  // Una venta saldada ya no tiene condiciones de pago que explicar (tasa del día, descuento en divisas).
  const porPagar = !isVenta || cobro.saldoReal > 0.005
  const docLabel = isVenta ? 'Nota de venta' : isPresupuesto ? 'Presupuesto' : 'Pedido'
  // Cada cobro (y vuelto) con lo que entró: Bs exactos si fue en Bs, y lo que acreditó en la
  // unidad del documento (BCV si modoBcv, con la proporción del propio pedido).
  const fmtCorta = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })
  const cobros = presupuesto.movimientos.map(m => {
    const devolucion = m.categoria === 'devolucion_cliente'
    const bs = m.montoBs != null ? Number(m.montoBs) : null
    return {
      id: m.id,
      texto: [
        devolucion ? (isVenta ? 'Vuelto' : 'Devolución') : m.metodoPago ?? 'Cobro',
        fmtCorta(m.fecha),
        bs != null ? `Bs ${bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
      ].filter(Boolean).join(' · '),
      monto: (devolucion ? -1 : 1) * (cobro.factor > 0 ? Number(m.monto) / cobro.factor : Number(m.monto)),
    }
  })
  const fileName = toFileName(
    [docLabel, presupuesto.clientName, String(presupuesto.id).padStart(4, '0')],
    'pdf'
  )

  const pdfData: PresupuestoPdfData = {
    docLabel,
    numero,
    fecha,
    validez: isPresupuesto ? validez : null,
    esVenta: isVenta,
    cobros: isVenta ? cobros.map(c => ({ texto: c.texto, monto: c.monto })) : undefined,
    clientName: presupuesto.clientName,
    expressPlazo: express ? plazoExpress(cfg) : null,
    notas: presupuesto.notas,
    items: items.map(item => {
      // Solo cuando el producto apunta a UNA moto (los ensambles): la lista larga de
      // compatibilidades de una pieza suelta no le dice nada al cliente.
      const m = modeloLabel(toModelIds(item.cab.compatibleModels))
      return {
      nameEs: item.cab.nameEs,
      bajajCode: item.cab.bajajCode,
      modelo: m && m.count === 1 ? m.full : null,
      quantity: item.quantity,
      unitPrice: aBcv(parseFloat(item.salePrice.toString())),
      subtotal: aBcv(parseFloat(item.salePrice.toString())) * item.quantity,
      bundlePieces: (item.bundleItems as BundlePiece[] | null) ?? [],
      }
    }),
    total: totalMostrado,
    totalBsd,
    modoBcv,
    tasaBcv: modoBcv ? tasaBcv : null,
    descuentoDivisasPct,
    totalDivisas: cobro.totalReal,
    isPresupuesto,
    deposit,
    depositUsd: depositUsd != null ? cobro.abonadoBcv : null,
    saldoUsd: depositUsd != null ? cobro.saldoBcv : null,
    depositAt: presupuesto.depositAt
      ? new Date(presupuesto.depositAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })
      : null,
    paymentMethod: presupuesto.paymentMethod,
    // Los términos son los de un pedido (adelanto, plazos): no aplican a lo que se llevó del depósito.
    terminos: isVenta ? null : terminos,
  }

  // ── Cabecera: un estado, un paso siguiente y una acción principal (el resto en "Más") ──
  const chip = 'inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap'
  const n = presupuesto.items.length
  const entregadoTodo = compra?.allDelivered ?? false
  const etapa = compra && !isPresupuesto && !isVenta ? etapaVisible(entregadoTodo ? 'entregado' : compra.lead.value, isPropio) : null
  const recibidas = presupuesto.items.filter(it => it.shippingStatus === 'en_venezuela' || isDelivered(it.shippingStatus)).length
  const puedeEntregar = porEntregar.some(l => !l.motivo)
  const motos = modeloLabel([...new Set(items.flatMap(it => toModelIds(it.cab.compatibleModels)))])
  const pasos: { t: string; hecho: boolean }[] | null = isVenta || isCancelado || perdido
    ? null
    : isPresupuesto
      ? [{ t: 'Cotizado', hecho: true }, { t: vencido ? 'Renovar' : 'Confirmar con adelanto', hecho: false }, { t: 'Comprar', hecho: false }, { t: 'Recibir', hecho: false }, { t: 'Entregar', hecho: false }]
      : compra
        ? [
            { t: isPropio ? 'Armado' : 'Confirmado', hecho: true },
            { t: `Comprado ${compra.comprados}/${n}`, hecho: compra.pendientes === 0 },
            { t: 'En camino', hecho: recibidas === n || (compra.pendientes === 0 && compra.leadIndex >= statusIndex('camino_usa')) },
            ...(isPropio
              ? [{ t: `En depósito ${compra.entregados}/${n}`, hecho: entregadoTodo }]
              : [{ t: `Recibido ${recibidas}/${n}`, hecho: recibidas === n }, { t: `Entregado ${compra.entregados}/${n}`, hecho: entregadoTodo }]),
          ]
        : null
  const siguiente = pasos?.findIndex(p => !p.hecho) ?? -1
  // Problemas abiertos en las líneas: se avisan arriba, se resuelven en cada línea.
  const abiertas = presupuesto.incidencias.filter(i => i.estado === 'abierta' && i.itemId != null)
  const nombreDeLinea = (itemId: number | null) => items.find(it => it.id === itemId)?.cab.nameEs ?? 'una línea'
  const saldoBcv = cobro.saldoBcv
  const cobrarEsPrincipal = (isVenta && cobro.saldoReal > 0.005) || (isConfirmadoCliente && entregadoTodo && saldoBcv > 0.005)
  const registrarCobro = (principal: boolean) => (
    <RegistrarPagoClienteForm
      action={registrarPagoPedido.bind(null, id)}
      methods={METODOS_PAGO_INGRESO}
      modoBcv={modoBcv}
      tasaBs={tasaBsCobro}
      saldo={{ bs: cobro.saldoBcv, divisas: cobro.saldoReal }}
      etiqueta="Registrar cobro"
      claseBoton={principal ? BOTON.primario : ITEM_MENU}
    />
  )
  const separador = <div role="separator" className="my-1 border-t border-gray-100" />
  const bloqueado = (texto: string, motivo: string) => (
    <>
      <button type="button" disabled className={ITEM_MENU}>{texto}</button>
      <p className="px-3 pb-2 text-xs text-gray-500 text-pretty">{motivo}</p>
    </>
  )
  const eliminar = isVenta ? (
    <DeleteButton
      action={anularVenta.bind(null, id)}
      label="Anular venta…"
      className={ITEM_MENU_PELIGRO}
      confirmMessage={`¿Anular la venta a "${presupuesto.clientName}"? Las piezas vuelven al depósito y se sacan sus cobros del libro. Si el cliente ya se llevó la mercancía y hay que devolverle plata, no es esto: anotá un egreso aparte.`}
    />
  ) : noEliminable ? bloqueado('Eliminar', `No se elimina: ${noEliminable}`) : (
    <DeleteButton
      action={deletePresupuesto.bind(null, id)}
      label="Eliminar…"
      className={ITEM_MENU_PELIGRO}
      confirmMessage={`¿Eliminar ${isPropio ? 'stock propio' : isPresupuesto ? 'presupuesto' : 'pedido'} de "${presupuesto.clientName}"?`}
    />
  )
  const principal = perdido ? (
    <FormConResultado action={reabrirPresupuesto.bind(null, id)}>
      <PendingButton pendingLabel="Reabriendo…" className={BOTON.primario}>Reabrir</PendingButton>
    </FormConResultado>
  ) : !isPropio && isPresupuesto ? (
    // Un presupuesto vencido no se confirma: sus precios y su escalón BCV ya no valen.
    vencido ? <RenovarPresupuestoButton action={renovarPresupuesto.bind(null, id)} etiqueta="Renovar" claseBoton={BOTON.primario} /> : (
      <AprobarPedidoForm
        action={aprobarPedido.bind(null, id)}
        methods={METODOS_PAGO_INGRESO}
        montos={{ bs: deposit, divisas: depositDivisas }}
        modoBcv={modoBcv}
        tasaBs={tasaBsCobro}
        etiqueta="Confirmar con adelanto"
        claseBoton={BOTON.primario}
      />
    )
  ) : isConfirmadoCliente && puedeEntregar ? (
    <ConfirmarEntregaForm
      action={confirmarEntrega.bind(null, id)}
      lineas={porEntregar}
      methods={METODOS_PAGO_INGRESO}
      modoBcv={modoBcv}
      saldo={{ bs: cobro.saldoBcv, divisas: cobro.saldoReal }}
      tasaBs={tasaBsCobro}
      tasaDevolucion={tasaDevolucion}
      etiqueta="Entregar"
      claseBoton={BOTON.entregar}
    />
  ) : cobrarEsPrincipal ? registrarCobro(true)
  : isCancelado && depositUsd != null && depositUsd > 0.005 ? (
    <DevolverClienteForm action={devolverAlCliente.bind(null, id)} maximo={depositUsd} tasaSugerida={tasaDevolucion} claseBoton={BOTON.primario} />
  ) : null
  const fechaDoc = isPresupuesto ? fecha : fmtDate(presupuesto.createdAt)

  return (
    <div className="max-w-5xl">
      <nav aria-label="Ruta" className="flex items-center gap-2 mb-1 text-sm">
        <Link href={`/${ruta}`} className="text-gray-500 hover:text-gray-800 hover:underline">{isVenta ? 'Ventas' : 'Presupuestos'}</Link>
        <span aria-hidden="true" className="text-gray-300">/</span>
        <span className="text-gray-600">#{presupuesto.id}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-bold text-gray-900 break-words text-balance">{presupuesto.clientName}</h1>
            {isPropio && <span className={`${chip} bg-blue-100 text-blue-700`}>Stock propio</span>}
            {express && <span className={`${chip} bg-amber-100 text-amber-800`}>⚡ Express</span>}
            {/* Por Miami, el reenvío con el que se cotizó (y en qué caja va a viajar). No va al PDF. */}
            {!express && presupuesto.via !== 'express' && presupuesto.reenvio === 'por_kilo' && (
              <span className={`${chip} bg-orange-100 text-orange-800`}>
                Reenvío por kilo{presupuesto.tarifaKgInr != null ? ` · ₹${Number(presupuesto.tarifaKgInr)}/kg` : ''}
              </span>
            )}
            {isVenta ? <span className={`${chip} bg-green-100 text-green-700`}>Venta del depósito</span>
              : isCancelado ? <span className={`${chip} bg-red-100 text-red-700`}>Cancelado</span>
              : perdido ? <span className={`${chip} bg-gray-200 text-gray-700`}>Presupuesto perdido</span>
              : vencido ? <span className={`${chip} bg-red-100 text-red-700`}>Presupuesto vencido</span>
              : isPresupuesto ? <span className={`${chip} bg-yellow-100 text-yellow-800`}>Presupuesto · sin confirmar</span>
              : etapa && <span className={`${chip} ${etapa.badge}`}><span aria-hidden="true">{etapa.icon}</span> {etapa.short}{compra?.mixed && !entregadoTodo ? ' +' : ''}</span>}
          </div>
          <p className="text-sm text-gray-500 mt-1 text-pretty">
            {isVenta ? 'Vendido' : isPresupuesto ? 'Cotizado' : isPropio ? 'Armado' : 'Confirmado'} el {fechaDoc}
            {isPresupuesto && !perdido && (
              vencido
                ? <> · <span className="text-red-700 font-medium">venció el {validez}</span></>
                : <> · <span className={vigencia.diasRestantes <= 2 ? 'text-amber-800 font-medium' : ''}>vale hasta el {validez} ({vigencia.diasRestantes === 0 ? 'hoy' : vigencia.diasRestantes === 1 ? 'mañana' : `${vigencia.diasRestantes} días`})</span></>
            )}
            {motos && <> · <span title={motos.full}>{motos.label}</span></>}
            {presupuesto.clienteId && <> · <Link href={`/clientes/${presupuesto.clienteId}`} className="text-blue-700 hover:underline">ver cliente</Link></>}
          </p>
          {presupuesto.notas && <p className="text-sm text-gray-700 mt-1 break-words text-pretty"><span className="text-gray-500">Notas:</span> {presupuesto.notas}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isPropio && (avisoEstado ? (
            // Sin teléfono, wa.me deja elegir el contacto en WhatsApp.
            <a href={`https://wa.me/${tel ?? ''}?text=${encodeURIComponent(avisoEstado)}`} target="_blank" rel="noopener noreferrer" className={BOTON.whatsapp}>
              {compra?.lead.value === 'en_venezuela' ? 'Avisar que llegó' : 'Avisar por WhatsApp'}
            </a>
          ) : tel && (
            <a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer" className={BOTON.whatsapp}>WhatsApp</a>
          ))}
          <PresupuestoPdfButton fileName={fileName} data={pdfData} />
          {!isPropio && isPresupuesto && !perdido && (
            <Link href={`/presupuestos/${id}/edit`} className={BOTON.secundario}>Editar</Link>
          )}
          <MenuMas etiqueta={`Más acciones de ${isPresupuesto ? 'este presupuesto' : isVenta ? 'esta venta' : 'este pedido'}`}>
            {isPropio && <Link href={`/presupuestos/${id}/edit`} className={ITEM_MENU}>Editar</Link>}
            {isConfirmadoCliente && <Link href={`/presupuestos/${id}/edit`} className={ITEM_MENU}>Editar pedido</Link>}
            {!isPropio && !isPresupuesto && !isCancelado && !cobrarEsPrincipal && (!isVenta || cobro.saldoReal > 0.005) && registrarCobro(false)}
            {/* Una venta no tiene adelanto: un cobro mal anotado se borra en Contabilidad. */}
            {!isPropio && !isPresupuesto && !isCancelado && !isVenta && (
              <AprobarPedidoForm
                mode="editar"
                action={aprobarPedido.bind(null, id)}
                methods={METODOS_PAGO_INGRESO}
                montos={depositUsd != null ? { bs: cobro.abonadoBcv, divisas: depositUsd } : { bs: deposit, divisas: depositDivisas }}
                modoBcv={modoBcv}
                tasaBs={tasaBsCobro}
                initialMethod={presupuesto.paymentMethod}
                initialDate={depositDateStr}
                claseBoton={ITEM_MENU}
              />
            )}
            {isConfirmadoCliente && saldoAFavor > 0.005 && (
              <DevolverClienteForm action={devolverAlCliente.bind(null, id)} maximo={saldoAFavor} tasaSugerida={tasaDevolucion} etiqueta={`Devolver ${'$'}${saldoAFavor.toFixed(2)} a favor`} claseBoton={ITEM_MENU} />
            )}
            {!isVenta && (
              <>
                <Link href={`/presupuestos/${id}/comparar`} className={ITEM_MENU}>Comparar proveedores</Link>
                <Link href={`/presupuestos/${id}/proveedor`} className={ITEM_MENU}>Para proveedor</Link>
                <Link href={`/presupuestos/new?desde=${id}`} className={ITEM_MENU}>Duplicar</Link>
              </>
            )}
            {separador}
            {presupuesto.tipo === 'cliente' && isPresupuesto && !perdido && (
              // El cliente dijo que no: se cierra sin borrarlo, para que cuente en la conversión.
              <details>
                <summary className={`${ITEM_MENU} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}>Marcar como perdido…</summary>
                <FormConResultado action={marcarPerdido.bind(null, id)} className="px-3 pb-2 pt-1 flex flex-col gap-2">
                  <label className="text-xs text-gray-600">
                    ¿Por qué no se cerró? (opcional)
                    <input name="motivo" className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" placeholder="Precio, demora, lo consiguió en otro lado…" />
                  </label>
                  <PendingButton pendingLabel="Guardando…" className={`self-end ${BOTON.secundario}`}>Marcar como perdido</PendingButton>
                </FormConResultado>
              </details>
            )}
            {isConfirmadoCliente && (noCancelable ? bloqueado('Cancelar pedido', `No se cancela: ${noCancelable}`) : (
              <CancelarPedidoForm
                action={cancelarPedido.bind(null, id)}
                clientName={presupuesto.clientName}
                depositUsd={depositUsd ?? 0}
                compradas={resumenCancel.compradas}
                libres={resumenCancel.libres}
                devolucionSugerida={devolucionSugerida(depositUsd ?? 0, resumenCancel)}
                tasaSugerida={tasaDevolucion}
                etiqueta="Cancelar pedido…"
                claseBoton={ITEM_MENU_PELIGRO}
              />
            ))}
            {eliminar}
          </MenuMas>
          {principal}
        </div>
      </div>

      {pasos && (
        <ol aria-label={isPropio ? 'Avance del stock propio' : isPresupuesto ? 'Avance del presupuesto' : 'Avance del pedido'} className="flex flex-wrap gap-1.5 mb-4">
          {pasos.map((p, i) => (
            <li
              key={p.t}
              aria-current={i === siguiente ? 'step' : undefined}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                p.hecho ? 'bg-green-100 text-green-800' : i === siguiente ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {p.hecho && <span aria-hidden="true">✓ </span>}{p.t}
              {p.hecho ? <span className="sr-only"> (hecho)</span> : i === siguiente ? <span className="sr-only"> (siguiente)</span> : null}
            </li>
          ))}
        </ol>
      )}

      {isCancelado && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3 mb-4 text-sm text-red-900">
          <p className="font-semibold">
            Pedido cancelado{presupuesto.canceladoAt ? ` el ${fmtDate(presupuesto.canceladoAt)}` : ''}
          </p>
          {presupuesto.canceladoMotivo && <p className="mt-0.5">{presupuesto.canceladoMotivo}</p>}
          <p className="text-xs mt-1">
            {depositUsd != null && depositUsd > 0.005
              ? <>Se quedó <strong>${depositUsd.toFixed(2)}</strong> de lo cobrado (cuenta en el resultado del mes).</>
              : 'No quedó plata cobrada.'}
            {presupuesto.derivados.filter(d => d.origenMotivo === 'sobrante').map(d => (
              <span key={d.id}> Lo que ya estaba comprado pasó a <Link href={`/presupuestos/${d.id}`} className="underline">stock propio #{d.id}</Link>.</span>
            ))}
          </p>
        </div>
      )}
      {perdido && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-3 mb-4 text-sm text-gray-700">
          <p className="font-semibold">Presupuesto perdido el {fmtDate(presupuesto.perdidoAt!)}{presupuesto.perdidoMotivo ? `: ${presupuesto.perdidoMotivo}` : '.'}</p>
          <p className="text-xs mt-0.5">No se puede confirmar. Si el cliente vuelve, reabrilo.</p>
        </div>
      )}
      {vencido && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3 mb-4 text-sm text-red-900">
          <p className="font-semibold">Este presupuesto venció el {validez}: así no se puede confirmar.</p>
          <p className="text-xs mt-0.5 text-pretty">
            Los precios y la tasa BCV con que se cotizó ya no valen. Mirá si los precios siguen
            siendo los de hoy (Editar los vuelve a cotizar) o renovalo tal cual: toma la fecha y el escalón BCV de hoy.
          </p>
        </div>
      )}
      {abiertas.length > 0 && !isCancelado && (
        <div role="note" className="bg-red-50 border border-red-200 rounded-xl px-5 py-3 mb-4 text-sm text-red-900">
          <p className="font-semibold">
            {abiertas.length === 1 ? 'Un problema abierto' : `${abiertas.length} problemas abiertos`}: mientras sigan así, esas líneas no se entregan
          </p>
          <ul className="text-xs mt-1 space-y-0.5">
            {abiertas.map(i => (
              <li key={i.id}>
                {nombreDeLinea(i.itemId)}{i.pieza ? ` (${i.pieza})` : ''}: {i.tipo === 'sin_enviar' ? 'el proveedor no la mandó' : (TIPO_LABELS[i.tipo as keyof typeof TIPO_LABELS] ?? i.tipo).toLowerCase()}
              </li>
            ))}
          </ul>
          <p className="text-xs mt-1">Se cierran en cada línea, abajo.</p>
        </div>
      )}
      {presupuesto.origen && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 mb-4 text-sm text-blue-900">
          {presupuesto.origenMotivo === 'reposicion' ? 'Reposición del pedido' : 'Sobrante del pedido'}{' '}
          <Link href={`/presupuestos/${presupuesto.origen.id}`} className="font-semibold underline">
            #{presupuesto.origen.id} · {presupuesto.origen.clientName}
          </Link>
          {presupuesto.origenMotivo === 'reposicion'
            ? '. Se vuelve a mandar sin costo para el cliente; lo que cuesta traerlo queda como margen negativo de este pedido.'
            : '. Eran piezas ya compradas para ese pedido que el cliente no se lleva; pasaron acá con su costo.'}
        </div>
      )}
      {!presupuesto.origen && presupuesto.derivados.length > 0 && !isCancelado && (
        <p className="text-xs text-gray-500 mb-4">
          Pedidos que nacieron de éste:{' '}
          {presupuesto.derivados.map(d => (
            <Link key={d.id} href={`/presupuestos/${d.id}`} className="text-blue-700 hover:underline mr-2">
              #{d.id} ({d.origenMotivo === 'reposicion' ? 'reposición' : 'sobrante'})
            </Link>
          ))}
        </p>
      )}

      {/* Lo que importa de la plata, de un vistazo. A dólar BCV, lo cobrado y el saldo se muestran en
          BCV (lo que dice la tabla) y, debajo, en divisas: lo guardado es real y un pago en divisas cancela el real. */}
      {!isPropio && (
        <dl className="grid grid-cols-3 bg-white rounded-xl border border-gray-200 shadow-sm mb-4 divide-x divide-gray-100">
          <div className="px-4 py-3 min-w-0">
            <dt className="text-xs text-gray-500">{modoBcv ? 'Total (BCV)' : 'Total'}</dt>
            <dd className="text-lg font-bold font-mono tabular-nums text-gray-900">${totalMostrado.toFixed(2)}</dd>
          </div>
          {isPresupuesto ? (
            <>
              <div className="px-4 py-3 min-w-0">
                <dt className="text-xs text-gray-500">{modoBcv && descuentoDivisasPct > 0 ? `En divisas (−${descuentoDivisasPct}%)` : 'En divisas'}</dt>
                <dd className={`text-lg font-bold font-mono tabular-nums ${modoBcv && descuentoDivisasPct > 0 ? 'text-green-700' : 'text-gray-900'}`}>${cobro.totalReal.toFixed(2)}</dd>
              </div>
              <div className="px-4 py-3 min-w-0">
                <dt className="text-xs text-gray-500">Adelanto para confirmar</dt>
                <dd className="text-lg font-bold font-mono tabular-nums text-gray-900">${deposit.toFixed(2)}</dd>
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 min-w-0">
                <dt className="text-xs text-gray-500">{isVenta ? 'Pagado' : 'Cobrado'}</dt>
                <dd className="text-lg font-bold font-mono tabular-nums text-gray-900">${cobro.abonadoBcv.toFixed(2)}</dd>
                {modoBcv && depositUsd != null && <dd className="text-[11px] text-gray-500 font-mono tabular-nums">${depositUsd.toFixed(2)} en divisas</dd>}
              </div>
              <div className="px-4 py-3 min-w-0">
                <dt className="text-xs text-gray-500">{isCancelado ? 'Se quedó' : saldoAFavor > 0.005 ? 'A favor del cliente' : 'Saldo'}</dt>
                {isCancelado ? (
                  <dd className="text-lg font-bold font-mono tabular-nums text-red-800">${(depositUsd ?? 0).toFixed(2)}</dd>
                ) : (
                  <>
                    <dd className={`text-lg font-bold font-mono tabular-nums ${saldoBcv > 0.005 ? 'text-amber-800' : 'text-green-700'}`}>
                      {Math.abs(saldoBcv) > 0.005 ? `$${Math.abs(saldoBcv).toFixed(2)}` : 'Pagado'}
                    </dd>
                    {modoBcv && Math.abs(cobro.saldoReal) > 0.005 && <dd className="text-[11px] text-gray-500 font-mono tabular-nums">${Math.abs(cobro.saldoReal).toFixed(2)} en divisas</dd>}
                  </>
                )}
              </div>
            </>
          )}
        </dl>
      )}

      {/* Express: el paquete (con lo que ya va en su caja) contra el tope, y lo que se gana sobre su parte. */}
      {express && (
        <div className={`rounded-xl border-2 p-6 mb-4 ${express.excede ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className={`font-semibold ${express.excede ? 'text-red-800' : 'text-green-800'}`}>
              ⚡ Paquete express: {express.porUsa
                ? 'por USA (DDP), sin tope'
                : express.excede
                  ? `se pasa $${(-express.holguraUsd).toFixed(2)} del tope`
                  : `entra, quedan $${express.holguraUsd.toFixed(2)}`}
            </h2>
            <span className="text-sm font-mono text-gray-600">${express.paqueteUsd.toFixed(2)}{express.porUsa ? '' : ` de ${express.topeUsd.toFixed(2)}`}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500">Peso cobrable</p>
              <p className="font-mono font-semibold">{express.chargeableKg.toFixed(2)} kg</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">{express.porUsa ? 'Flete depósito → Miami → VEN' : 'Flete Shoppre → VEN'}</p>
              <p className="font-mono font-semibold">${express.fleteUsd.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Landed estimado</p>
              <p className="font-mono font-semibold">${express.landedUsd.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Margen sobre lo cotizado</p>
              <p className={`font-mono font-semibold ${total - express.landedUsd < 0 ? 'text-red-700' : 'text-green-700'}`}>
                ${(total - express.landedUsd).toFixed(2)}
                {total > 0 && <span className="text-xs font-normal ml-1">({(((total - express.landedUsd) / total) * 100).toFixed(1)}%)</span>}
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            {express.cajaId != null
              ? <>{express.lineasEnCaja ? 'Va en la' : 'Cotizado con la'} <Link href={`/envios/${express.cajaId}`} className="underline">caja #{express.cajaId}</Link> ({express.envio.air.chargeableKg.toFixed(2)} kg con todo): el flete es el de la caja y esto es su parte.{express.lineasEnCaja ? ' ' : ' Entra en la caja al confirmarlo. '}</>
              : 'Sin caja: se cotiza como paquete solo. '}
            Con las tarifas de hoy, sumando el peso de las piezas: la caja real puede pesar algo más.
          </p>
          {motivoExpress && <p className="text-sm text-red-800 mt-2">No se puede confirmar así: {motivoExpress}</p>}
        </div>
      )}

      {/* Items table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto mb-4">
        <table className="w-full">
          <caption className="sr-only">Piezas de {isPresupuesto ? 'este presupuesto' : 'este pedido'}</caption>
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th scope="col" className="w-16 px-3 py-3 hidden sm:table-cell"><span className="sr-only">Foto</span></th>
              <th scope="col" className="text-left px-3 py-3 text-xs font-semibold text-gray-500">Pieza</th>
              <th scope="col" className="text-center px-2 sm:px-4 py-3 text-xs font-semibold text-gray-500 w-14 sm:w-20">Cant.</th>
              <th scope="col" className="text-right px-4 py-3 text-xs font-semibold text-gray-500 w-28 hidden sm:table-cell">
                P. unit.{modoBcv && ' (BCV)'}
              </th>
              <th scope="col" className="text-right px-3 sm:px-6 py-3 text-xs font-semibold text-gray-500 w-24 sm:w-28">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(item => {
              const unitPrice = aBcv(parseFloat(item.salePrice.toString()))
              const subtotal = unitPrice * item.quantity
              const bundlePieces = (item.bundleItems as BundlePiece[] | null) ?? []
              const modelo = modeloLabel(toModelIds(item.cab.compatibleModels))
              const et = etapaVisible(item.shippingStatus, isPropio)
              return (
                <tr key={item.id}>
                  <td className="px-3 py-3 align-top hidden sm:table-cell">
                    {item.cab.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.cab.imageUrl}
                        alt={item.cab.nameEs}
                        loading="lazy"
                        className="size-12 object-contain rounded-lg border border-gray-100 bg-white"
                      />
                    ) : (
                      <div className="size-12 rounded-lg border border-dashed border-gray-200 bg-gray-50" />
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="text-sm font-medium text-gray-900">{item.cab.nameEs}</p>
                    {(item.cab.bajajCode || modelo) && (
                      <p className="flex items-center gap-1.5 flex-wrap mt-0.5">
                        {item.cab.bajajCode && (
                          <span className="text-xs font-mono text-gray-500">{item.cab.bajajCode}</span>
                        )}
                        {modelo && (
                          <span
                            title={modelo.full}
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              modelo.count === 1 ? 'bg-gray-100 text-gray-700 font-medium' : 'bg-gray-50 text-gray-600'
                            }`}
                          >
                            {modelo.label}
                          </span>
                        )}
                      </p>
                    )}
                    {!isPresupuesto && (
                      <p className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap text-xs">
                        <span className={`font-semibold px-2 py-0.5 rounded-full ${et.badge}`}>
                          <span aria-hidden="true">{et.icon}</span> {et.short}
                        </span>
                        {item.compradoAt && (
                          <span className="text-gray-500">
                            <span aria-hidden="true">{item.origen === 'china' ? '🇨🇳' : '🇮🇳'}</span> {item.supplier?.name ?? '99rpm'}
                          </span>
                        )}
                        {item.envio && (
                          <Link href={`/envios/${item.envio.id}`} className="text-blue-700 hover:underline">
                            caja #{item.envio.id}{item.envio.nombre ? ` ${item.envio.nombre}` : ''}
                          </Link>
                        )}
                      </p>
                    )}
                    {isConfirmadoCliente && (item.desdeStock ? item.shippingStatus === 'en_venezuela' : !motivoNoServible(
                      { ...item, costRealUsd: item.costRealUsd != null ? Number(item.costRealUsd) : null },
                      presupuesto,
                      item.product ? { stock: item.product.stock, costoUnitUsd: item.product.landedCostUsd != null ? Number(item.product.landedCostUsd) : null } : null,
                    )) && (
                      // Si la pieza ya está en el depósito no hace falta comprarla ni que viaje.
                      <LineaDeposito
                        modo={item.desdeStock ? 'servida' : 'servible'}
                        enDeposito={item.product?.stock}
                        servir={servirDesdeStock.bind(null, item.id)}
                        devolver={devolverAlDeposito.bind(null, item.id)}
                      />
                    )}
                    {(isConfirmadoCliente || (isPropio && presupuesto.status === 'pedido')) && (
                      <IncidenciasLinea
                        itemId={item.id}
                        piezas={Array.isArray(item.bundleItems)
                          ? (item.bundleItems as unknown as BundlePiece[]).map(p => ({ etiqueta: etiquetaPieza(p), quantity: p.quantity }))
                          : undefined}
                        editarHref={`/presupuestos/${presupuesto.id}/edit`}
                        tipos={(isPropio ? tiposParaPropio : tiposPara)({ shippingStatus: item.shippingStatus, costRealUsd: item.costRealUsd != null ? Number(item.costRealUsd) : null })}
                        propio={isPropio}
                        metodosProveedor={METODOS_PAGO_EGRESO}
                        linea={{ quantity: item.quantity, salePrice: parseFloat(item.salePrice.toString()), costRealUsd: item.costRealUsd != null ? Number(item.costRealUsd) : null }}
                        pedido={{ totalReal: totalRealPedido, depositUsd: depositUsd ?? 0 }}
                        tasaSugerida={tasaDevolucion}
                        incidencias={incidenciasDe(item.id)}
                        reportar={reportarIncidencia}
                        resolver={resolverIncidencia}
                      />
                    )}
                    {!isPresupuesto && item.etapas.length > 0 && (
                      <details className="mt-1">
                        <summary className="inline-flex items-center min-h-6 text-xs text-gray-500 cursor-pointer hover:text-gray-800">Recorrido ({item.etapas.length})</summary>
                        <ul className="mt-1 text-xs text-gray-500 space-y-0.5">
                          {item.etapas.map((e, k) => (
                            <li key={k}>
                              <span className="font-mono tabular-nums">{e.at.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })}</span>{' '}
                              {etapaVisible(e.desde, isPropio).short} → <strong className="text-gray-700">{etapaVisible(e.hacia, isPropio).short}</strong>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {bundlePieces.length > 0 && (
                      <div className="mt-1.5 ml-1 pl-3 border-l-2 border-gray-100 space-y-1.5">
                        {groupBundlePieces(bundlePieces).map(([groupName, pieces]) => (
                          <div key={groupName}>
                            {groupName !== '—' && (
                              <p className="text-xs font-semibold text-gray-500">{groupName}</p>
                            )}
                            <ul className="space-y-0.5">
                              {pieces.map((p, i) => (
                                <li key={i} className="text-xs text-gray-500">
                                  {/* Cantidad POR SET: la columna Cant. ya es el multiplicador
                                      del conjunto, mostrar el total acá lo aplicaba dos veces. */}
                                  {p.quantity}× {p.nameEs}
                                  {p.bajajCode && <span className="ml-1.5 font-mono">{p.bajajCode}</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-2 sm:px-4 py-3 text-center text-sm text-gray-700 align-top tabular-nums">{item.quantity}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono text-gray-700 align-top tabular-nums hidden sm:table-cell">
                    ${unitPrice.toFixed(2)}
                  </td>
                  <td className="px-3 sm:px-6 py-3 text-right text-sm font-mono font-semibold text-gray-900 align-top tabular-nums">
                    ${subtotal.toFixed(2)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Las condiciones del documento, como van en el PDF. El total del pedido está arriba; lo
          propio no tiene franja de plata, así que su total va acá. */}
      <div className="flex justify-end mb-4">
        <div className="w-full sm:w-96 space-y-1.5 text-right">
          {isPropio && (
            <p className="flex justify-between items-baseline border-t-2 border-gray-200 pt-3">
              <span className="font-bold text-gray-900">Total USD</span>
              <span className="font-bold text-2xl font-mono tabular-nums text-gray-900">${totalMostrado.toFixed(2)}</span>
            </p>
          )}
          {modoBcv && porPagar && (
            <div className="text-xs text-gray-500">
              <p>Monto expresado en dólares a tasa BCV</p>
              <p>Se paga a la tasa BCV del día en que se realice el pago</p>
            </div>
          )}
          {modoBcv && descuentoDivisasPct > 0 && porPagar && (
            <p className="text-sm font-semibold text-green-700">
              Pagando en divisas se aplica un descuento del {descuentoDivisasPct}%: <span className="font-mono tabular-nums">${cobro.totalReal.toFixed(2)}</span>
            </p>
          )}
          {totalBsd != null && (
            <p className="text-sm text-gray-500">Referencia en bolívares: <span className="font-mono tabular-nums">Bs {totalBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}</span></p>
          )}
          {isPresupuesto && (
            <p className="text-sm font-semibold text-gray-800">Para confirmar el pedido se requiere un abono del 50%.</p>
          )}
        </div>
      </div>

      {incidenciasSinLinea.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-4 sm:px-6 py-3 mb-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Problemas de piezas que ya no están en el pedido</h2>
          <ul className="text-xs text-gray-600 space-y-1">
            {incidenciasSinLinea.map(i => (
              <li key={i.id}>
                {TIPO_LABELS[i.tipo as keyof typeof TIPO_LABELS] ?? i.tipo} · {i.cantidad}× «{i.descripcion}»
                {i.perdidaUsd != null && Number(i.perdidaUsd) > 0 && <span className="text-red-700"> · pérdida ${Number(i.perdidaUsd).toFixed(2)}</span>}
                {i.nota && <span className="text-gray-500"> — {i.nota}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Lo secundario, plegado: se abre cuando hace falta. */}
      <div className="space-y-2">
        {/* Margen: lo vendido contra lo que cuesta (o costó) tenerlo puesto acá, en dólares reales.
            Con todo entregado y costeado con lo pagado de verdad es el margen realizado; antes de
            eso es una proyección, y se dice. */}
        {margen && (
          <details className={plegable}>
            <summary className={resumenPlegable}>
              <span>Margen · {margen.estado === 'realizado' ? 'realizado'
                : margen.estado === 'estimado' ? 'entregado, costo estimado'
                : margen.estado === 'sin_costo' ? 'entregado, falta costo'
                : 'proyectado'}</span>
              {margen.margenUsd != null && (
                <span className={`font-mono tabular-nums ${margen.margenUsd < 0 ? 'text-red-700' : 'text-green-700'}`}>
                  {margen.margenUsd < 0 ? '−' : ''}${Math.abs(margen.margenUsd).toFixed(2)}
                  {margen.margenPct != null && <span className="font-normal"> ({margen.margenPct.toFixed(1)}%)</span>}
                </span>
              )}
            </summary>
            <div className="px-4 pb-4">
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-gray-500 mb-0.5">Vendido (reales)</dt>
                  <dd className="font-mono font-semibold tabular-nums text-gray-900">${margen.ventaUsd.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500 mb-0.5">Costo puesto acá</dt>
                  <dd className="font-mono font-semibold tabular-nums text-gray-900">
                    ${margen.costoUsd.toFixed(2)}
                    {margen.sinCosto > 0 && <span className="text-amber-700"> +?<span className="sr-only"> ({margen.sinCosto} línea(s) sin costo)</span></span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500 mb-0.5">Margen</dt>
                  {margen.margenUsd == null ? (
                    <dd className="font-mono text-gray-500">—</dd>
                  ) : (
                    <dd className={`font-mono font-semibold tabular-nums ${margen.margenUsd < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {margen.margenUsd < 0 ? '−' : ''}${Math.abs(margen.margenUsd).toFixed(2)}
                      {margen.margenPct != null && <span className="text-xs font-normal ml-1">({margen.margenPct.toFixed(1)}%)</span>}
                    </dd>
                  )}
                </div>
              </dl>
              {margen.sinCosto > 0 && (
                <p className="text-xs text-amber-700 mt-3">
                  {margen.sinCosto === 1 ? 'Una línea no tiene' : `${margen.sinCosto} líneas no tienen`} costo: no está en ninguna caja ni se cargó lo que costó. Hasta entonces no se sabe cuánto se gana.
                </p>
              )}
              {margen.margenUsd != null && margen.margenUsd < 0 && (
                <p className="text-xs text-red-700 mt-3">Este pedido pierde plata: lo que costó traerlo supera lo que se le cobró al cliente.</p>
              )}
            </div>
          </details>
        )}

        {!isPropio && !isPresupuesto && depositUsd != null && (cobros.length > 0 || presupuesto.depositAt) && (
          <details className={plegable}>
            <summary className={resumenPlegable}>
              <span>Cobros{cobros.length > 0 ? ` (${cobros.length})` : ''}{presupuesto.paymentMethod ? ` · ${presupuesto.paymentMethod}` : ''}</span>
              <span className="font-mono tabular-nums text-gray-700">${cobro.abonadoBcv.toFixed(2)}</span>
            </summary>
            <div className="px-4 pb-4">
              {cobros.length > 0 ? (
                <ul className="space-y-1 text-sm text-gray-700">
                  {cobros.map(c => (
                    <li key={c.id} className="flex justify-between gap-3">
                      <span>{c.texto}</span>
                      <span className="font-mono tabular-nums shrink-0">{c.monto < 0 ? '−' : ''}${Math.abs(c.monto).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              ) : presupuesto.depositAt && (
                <p className="text-sm text-gray-600">
                  Adelanto del {new Date(presupuesto.depositAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })}
                </p>
              )}
            </div>
          </details>
        )}

        {/* Peso y volumen del stock propio. Mismo cálculo que la página de envíos
            (calcEnvio), medido sobre las piezas reales: un conjunto se expande a lo que
            efectivamente lleva. Los ítems landed no entran — no viajan en la caja. */}
        {logistica && logistica.piezas > 0 && (
          <details className={plegable}>
            <summary className={resumenPlegable}>
              <span>Peso y volumen</span>
              <span className="font-mono tabular-nums text-gray-700">{logistica.chargeableKg.toFixed(2)} kg · {logistica.ft3.toFixed(2)} ft³</span>
            </summary>
            <div className="px-4 pb-4">
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <dt className="text-xs text-gray-500 mb-1">Peso real</dt>
                  <dd className={`text-xl font-bold font-mono tabular-nums ${logistica.realKg >= logistica.volKg ? 'text-green-700' : 'text-gray-900'}`}>{logistica.realKg.toFixed(2)} kg</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500 mb-1">Volumétrico</dt>
                  <dd className={`text-xl font-bold font-mono tabular-nums ${logistica.volKg > logistica.realKg ? 'text-red-700' : 'text-gray-900'}`}>{logistica.volKg.toFixed(2)} kg</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500 mb-1">Cobrable max(W,V)</dt>
                  <dd className="text-xl font-bold font-mono tabular-nums text-blue-700">{logistica.chargeableKg.toFixed(2)} kg</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500 mb-1">Volumen</dt>
                  <dd className="text-xl font-bold font-mono tabular-nums text-gray-900">{logistica.ft3.toFixed(2)} ft³</dd>
                  <dd className="text-xs text-gray-500 mt-0.5 font-mono tabular-nums">{logistica.cbm.toFixed(3)} CBM</dd>
                </div>
              </dl>
              {logistica.incompletas > 0 && (
                <p className="text-xs text-amber-700 mt-4">
                  ⚠ {logistica.incompletas} de {logistica.piezas}{' '}
                  {logistica.incompletas === 1 ? 'pieza no tiene' : 'piezas no tienen'} peso o
                  medidas cargadas: el total real es mayor que éste.
                </p>
              )}
            </div>
          </details>
        )}

        {/* Carga de medidas, de a un ensamble (ya viene plegada). Sin dimensiones no hay volumen,
            y sin volumen el flete por mar de esas piezas cuenta cero. */}
        {grupos.length > 0 && !isVenta && (
          <div id="medidas" className="scroll-mt-4">
            <MedidasIA grupos={grupos} revalidate={`/presupuestos/${id}`} titulo="Cargar peso y medidas de este presupuesto" />
          </div>
        )}

        {presupuesto.eventos.length > 0 && (
          <details className={plegable}>
            <summary className={resumenPlegable}><span>Historial ({presupuesto.eventos.length})</span></summary>
            <ul className="px-4 pb-4 space-y-2">
              {presupuesto.eventos.map(e => (
                <li key={e.id} className="text-xs text-gray-600 flex gap-3">
                  <span className="font-mono tabular-nums text-gray-500 shrink-0 w-24">
                    {e.createdAt.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'America/Caracas' })}
                  </span>
                  <span className="whitespace-pre-line">{e.detalle}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Términos: los mismos que van al PDF (ver getTerminos), visibles acá para
            poder revisarlos antes de mandarlo. */}
        {terminos && !isVenta && (
          <details className={plegable}>
            <summary className={resumenPlegable}><span>Términos y condiciones</span></summary>
            <p className="px-4 pb-4 text-xs leading-relaxed text-gray-600 whitespace-pre-line">{terminos}</p>
          </details>
        )}
      </div>
    </div>
  )
}

const plegable = 'bg-white rounded-xl shadow-sm border border-gray-200'
const resumenPlegable =
  'list-none [&::-webkit-details-marker]:hidden cursor-pointer flex flex-wrap items-center justify-between gap-x-4 gap-y-1 min-h-11 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 rounded-xl'
