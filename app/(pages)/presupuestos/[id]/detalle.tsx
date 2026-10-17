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
import { motivoNoServible } from '@/lib/venta-stock'
import { deletePresupuesto, aprobarPedido, registrarPagoPedido } from '../actions'
import {
  cancelarPedido, devolverAlCliente, devolverAlDeposito, entregarDesdeStock, marcarPerdido, servirDesdeStock, reabrirPresupuesto, renovarPresupuesto, reportarIncidencia,
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
import { METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { compararNombre, toFileName } from '@/lib/utils'
import type { PresupuestoPdfData } from '@/lib/pdf/presupuesto-pdf'
import { stageSummary, shippingStatusMeta, SHIPPING_STATUSES } from '@/lib/shipping-status'
import { modeloLabel, type MotoModelId, toModelIds } from '@/lib/modelo'
import { pedidoLogistics } from '@/lib/pedido-logistics'
import { num, toConfigMap } from '@/lib/config'
import { motivoNoEliminable } from '@/lib/pedido-eliminable'
import { cabeceraDeLinea } from '@/lib/linea-pedido'
import { cargarMargenes } from '@/lib/resultados'
import { estadoValidez, escalonDelPresupuesto, validezDias } from '@/lib/validez'
import { devolucionSugerida, motivoNoCancelable, resumenCancelacion } from '@/lib/pedido-cancelacion'
import { estadoLinea } from '@/lib/pedido-edicion'
import { etiquetaPieza, tiposPara, TIPO_LABELS } from '@/lib/incidencias'
import { saldoReal } from '@/lib/saldo-entrega'

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
            // La caja en que viaja (con su guía) y por qué etapas pasó: lo que se le contesta al
            // cliente cuando pregunta dónde está su pieza.
            envio: { select: { id: true, guia: true, transportista: true } },
            etapas: { select: { desde: true, hacia: true, at: true }, orderBy: { at: 'asc' } },
          },
          orderBy: { id: 'asc' },
        },
        incidencias: { orderBy: { id: 'asc' } },
        eventos: { orderBy: { createdAt: 'desc' } },
        origen: { select: { id: true, clientName: true } },
        derivados: { select: { id: true, origenMotivo: true }, orderBy: { id: 'asc' } },
        _count: { select: { movimientos: true } },
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
  const docLabel = isPresupuesto ? 'Presupuesto' : 'Pedido'
  const fileName = toFileName(
    [docLabel, presupuesto.clientName, String(presupuesto.id).padStart(4, '0')],
    'pdf'
  )

  const pdfData: PresupuestoPdfData = {
    docLabel,
    numero,
    fecha,
    validez: isPresupuesto ? validez : null,
    clientName: presupuesto.clientName,
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
    isPresupuesto,
    deposit,
    depositUsd: depositUsd != null ? cobro.abonadoBcv : null,
    saldoUsd: depositUsd != null ? cobro.saldoBcv : null,
    depositAt: presupuesto.depositAt
      ? new Date(presupuesto.depositAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })
      : null,
    paymentMethod: presupuesto.paymentMethod,
    terminos,
  }

  return (
    <div className="max-w-5xl">

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href={`/${ruta}`} className="text-gray-400 hover:text-gray-600 text-sm">
              {isVenta ? 'Ventas' : 'Presupuestos'}
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">#{presupuesto.id}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{presupuesto.clientName}</h1>
            {presupuesto.clienteId && (
              <Link href={`/clientes/${presupuesto.clienteId}`} className="text-sm text-blue-600 hover:text-blue-800">
                Ver cliente →
              </Link>
            )}
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isPropio
                ? 'bg-blue-100 text-blue-700'
                : isCancelado
                  ? 'bg-red-100 text-red-700'
                  : isPresupuesto
                    ? perdido ? 'bg-gray-200 text-gray-600' : vencido ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                    : 'bg-green-100 text-green-700'
            }`}>
              {isPropio ? 'Stock propio' : isVenta ? 'Venta del depósito' : isCancelado ? 'Cancelado' : isPresupuesto ? (perdido ? 'Presupuesto perdido' : vencido ? 'Presupuesto vencido' : 'Presupuesto') : 'Pedido confirmado'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {perdido && (
            <FormConResultado action={reabrirPresupuesto.bind(null, id)} className="flex items-center gap-2">
              <PendingButton pendingLabel="Reabriendo…" className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Reabrir
              </PendingButton>
            </FormConResultado>
          )}
          {!isPropio && isPresupuesto && !perdido && (
            <>
              <div className="relative">
                {vencido ? (
                  // Un presupuesto vencido no se confirma: sus precios y su escalón BCV ya no valen.
                  <RenovarPresupuestoButton action={renovarPresupuesto.bind(null, id)} />
                ) : (
                  <AprobarPedidoForm
                    action={aprobarPedido.bind(null, id)}
                    methods={METODOS_PAGO_INGRESO}
                    montos={{ bs: deposit, divisas: depositDivisas }}
                    modoBcv={modoBcv}
                    tasaBs={tasaBsCobro}
                  />
                )}
              </div>
              <Link
                href={`/presupuestos/${id}/edit`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Editar
              </Link>
              {presupuesto.tipo === 'cliente' && (
                // El cliente dijo que no: se cierra sin borrarlo, para que cuente en la conversión.
                <details className="relative">
                  <summary className="list-none cursor-pointer px-3 py-1.5 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">
                    Perdido
                  </summary>
                  <FormConResultado
                    action={marcarPerdido.bind(null, id)}
                    className="absolute right-0 z-10 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg p-3 flex flex-col gap-2"
                  >
                    <label className="text-xs text-gray-600">
                      ¿Por qué no se cerró? (opcional)
                      <input name="motivo" className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm" placeholder="Precio, demora, lo consiguió en otro lado…" />
                    </label>
                    <PendingButton pendingLabel="Guardando…" className="self-end px-3 py-1.5 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800">
                      Marcar como perdido
                    </PendingButton>
                  </FormConResultado>
                </details>
              )}
            </>
          )}
          {isCancelado && depositUsd != null && depositUsd > 0.005 && (
            <DevolverClienteForm action={devolverAlCliente.bind(null, id)} maximo={depositUsd} tasaSugerida={tasaDevolucion} />
          )}
          {isConfirmadoCliente && (
            <>
              <Link
                href={`/presupuestos/${id}/edit`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Editar pedido
              </Link>
              {saldoAFavor > 0.005 && (
                <DevolverClienteForm action={devolverAlCliente.bind(null, id)} maximo={saldoAFavor} tasaSugerida={tasaDevolucion} />
              )}
              {noCancelable ? (
                <span className="text-xs text-gray-400 cursor-help select-none" title={noCancelable}>🔒 No se puede cancelar</span>
              ) : (
                <CancelarPedidoForm
                  action={cancelarPedido.bind(null, id)}
                  clientName={presupuesto.clientName}
                  depositUsd={depositUsd ?? 0}
                  compradas={resumenCancel.compradas}
                  libres={resumenCancel.libres}
                  devolucionSugerida={devolucionSugerida(depositUsd ?? 0, resumenCancel)}
                  tasaSugerida={tasaDevolucion}
                />
              )}
            </>
          )}
          {!isPropio && !isPresupuesto && !isCancelado && (
            <div className="relative flex items-center gap-2">
              <RegistrarPagoClienteForm
                action={registrarPagoPedido.bind(null, id)}
                methods={METODOS_PAGO_INGRESO}
                modoBcv={modoBcv}
                tasaBs={tasaBsCobro}
                saldo={{ bs: cobro.saldoBcv, divisas: cobro.saldoReal }}
              />
              <AprobarPedidoForm
                mode="editar"
                action={aprobarPedido.bind(null, id)}
                methods={METODOS_PAGO_INGRESO}
                montos={
                  depositUsd != null
                    ? { bs: cobro.abonadoBcv, divisas: depositUsd }
                    : { bs: deposit, divisas: depositDivisas }
                }
                modoBcv={modoBcv}
                tasaBs={tasaBsCobro}
                initialMethod={presupuesto.paymentMethod}
                initialDate={depositDateStr}
              />
            </div>
          )}
          {isPropio && (
            <Link
              href={`/presupuestos/${id}/edit`}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Editar
            </Link>
          )}
          {!isVenta && (
            <>
              <Link
                href={`/presupuestos/${id}/comparar`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Comparar proveedores
              </Link>
              <Link
                href={`/presupuestos/${id}/proveedor`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Para proveedor
              </Link>
            </>
          )}
          <PresupuestoPdfButton fileName={fileName} data={pdfData} />
          {isVenta ? (
            <DeleteButton
              action={anularVenta.bind(null, id)}
              label="Anular venta"
              confirmMessage={`¿Anular la venta a "${presupuesto.clientName}"? Las piezas vuelven al depósito y se sacan sus cobros del libro. Si el cliente ya se llevó la mercancía y hay que devolverle plata, no es esto: anotá un egreso aparte.`}
            />
          ) : noEliminable ? (
            <span className="text-sm text-gray-400 cursor-help select-none" title={noEliminable}>
              🔒 No se puede eliminar
            </span>
          ) : (
            <DeleteButton
              action={deletePresupuesto.bind(null, id)}
              confirmMessage={`¿Eliminar ${isPropio ? 'stock propio' : isPresupuesto ? 'presupuesto' : 'pedido'} de "${presupuesto.clientName}"?`}
            />
          )}
        </div>
      </div>

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
          <p className="font-semibold">Este presupuesto venció el {validez}.</p>
          <p className="text-xs mt-0.5">
            Los precios y la tasa BCV con que se cotizó ya no valen, así que no se puede confirmar. Mirá si los precios siguen
            siendo los de hoy (Editar los vuelve a cotizar) o renovalo tal cual: toma la fecha y el escalón BCV de hoy.
          </p>
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
            <Link key={d.id} href={`/presupuestos/${d.id}`} className="text-blue-600 hover:underline mr-2">
              #{d.id} ({d.origenMotivo === 'reposicion' ? 'reposición' : 'sobrante'})
            </Link>
          ))}
        </p>
      )}

      {/* Client info */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
        <div className="flex justify-between text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Cliente</p>
            <p className="font-semibold text-gray-900 text-base">{presupuesto.clientName}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{isPresupuesto ? 'Cotizado' : 'Fecha'}</p>
            <p className="text-gray-700">{isPresupuesto ? fecha : fmtDate(presupuesto.createdAt)}</p>
            {isPresupuesto && (
              <p className={`text-xs mt-1 ${vencido ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                {vencido ? `Venció el ${validez}` : `Válido hasta ${validez}`}
              </p>
            )}
          </div>
        </div>
        {presupuesto.notas && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Notas</p>
            <p className="text-sm text-gray-700">{presupuesto.notas}</p>
          </div>
        )}
      </div>

      {/* Peso y volumen del stock propio. Mismo cálculo que la página de envíos
          (calcEnvio), medido sobre las piezas reales: un conjunto se expande a lo que
          efectivamente lleva. Los ítems landed no entran — no viajan en la caja. */}
      {logistica && logistica.piezas > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
            Peso y volumen
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Peso real</p>
              <p className={`text-xl font-bold font-mono ${
                logistica.realKg >= logistica.volKg ? 'text-green-700' : 'text-gray-900'
              }`}>
                {logistica.realKg.toFixed(2)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Volumétrico</p>
              <p className={`text-xl font-bold font-mono ${
                logistica.volKg > logistica.realKg ? 'text-red-700' : 'text-gray-900'
              }`}>
                {logistica.volKg.toFixed(2)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
              <p className="text-xl font-bold font-mono text-blue-700">
                {logistica.chargeableKg.toFixed(2)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Volumen</p>
              <p className="text-xl font-bold font-mono text-gray-900">
                {logistica.ft3.toFixed(2)} ft³
              </p>
              <p className="text-xs text-gray-400 mt-0.5 font-mono">
                {logistica.cbm.toFixed(3)} CBM
              </p>
            </div>
          </div>
          {logistica.incompletas > 0 && (
            <p className="text-xs text-amber-600 mt-4">
              ⚠ {logistica.incompletas} de {logistica.piezas}{' '}
              {logistica.incompletas === 1 ? 'pieza no tiene' : 'piezas no tienen'} peso o
              medidas cargadas: el total real es mayor que éste.
            </p>
          )}
        </div>
      )}

      {/* Margen: lo vendido contra lo que cuesta (o costó) tenerlo puesto acá, en dólares reales.
          Con todo entregado y costeado con lo pagado de verdad es el margen realizado; antes de
          eso es una proyección, y se dice. */}
      {margen && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Margen</h2>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              margen.estado === 'realizado' ? 'bg-green-100 text-green-700'
                : margen.estado === 'estimado' ? 'bg-blue-100 text-blue-700'
                : margen.estado === 'sin_costo' ? 'bg-amber-100 text-amber-700'
                : 'bg-gray-100 text-gray-600'
            }`}>
              {margen.estado === 'realizado' ? 'Realizado'
                : margen.estado === 'estimado' ? 'Entregado, costo estimado'
                : margen.estado === 'sin_costo' ? 'Entregado, falta costo'
                : 'Proyectado'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Vendido (reales)</p>
              <p className="font-mono font-semibold text-gray-900">${margen.ventaUsd.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Costo puesto acá</p>
              <p className="font-mono font-semibold text-gray-900">
                ${margen.costoUsd.toFixed(2)}
                {margen.sinCosto > 0 && <span className="text-amber-700" title={`${margen.sinCosto} línea(s) sin costo`}> +?</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Margen</p>
              {margen.margenUsd == null ? (
                <p className="font-mono text-gray-400">—</p>
              ) : (
                <p className={`font-mono font-semibold ${margen.margenUsd < 0 ? 'text-red-700' : 'text-green-700'}`}>
                  {margen.margenUsd < 0 ? '−' : ''}${Math.abs(margen.margenUsd).toFixed(2)}
                  {margen.margenPct != null && <span className="text-xs font-normal ml-1">({margen.margenPct.toFixed(1)}%)</span>}
                </p>
              )}
            </div>
          </div>
          {margen.sinCosto > 0 && (
            <p className="text-xs text-amber-700 mt-3">
              {margen.sinCosto === 1 ? 'Una línea no tiene' : `${margen.sinCosto} líneas no tienen`} costo: no está en ninguna caja ni se cargó lo que costó. Hasta entonces no se sabe cuánto se gana.
            </p>
          )}
          {margen.margenUsd != null && margen.margenUsd < 0 && (
            <p className="text-xs text-red-700 mt-3">Este pedido pierde plata: lo que costó traerlo supera lo que se le cobró al cliente.</p>
          )}
        </div>
      )}

      {/* Estado de compra — derivado de los ítems, no del pedido: de un mismo
          presupuesto unas piezas pueden estar compradas y otras no. */}
      {!isPresupuesto && !isCancelado && compra && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Estado de compra</h2>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${compra.lead.badge}`}>
              {compra.lead.icon} {compra.allDelivered ? 'Entregado' : compra.lead.short}
              {compra.mixed && !compra.allDelivered && ' +'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${compra.allDelivered ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.round((compra.leadIndex / (SHIPPING_STATUSES.length - 1)) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 shrink-0">
              {compra.comprados} de {compra.total} comprados
            </span>
          </div>
          {compra.pendientes > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              Faltan comprar {compra.pendientes} {compra.pendientes === 1 ? 'pieza' : 'piezas'}.{' '}
              <Link href="/compras" className="text-blue-600 hover:underline">Ir a Por comprar</Link>
            </p>
          )}
        </div>
      )}

      {/* Carga de medidas, de a un ensamble. Sin dimensiones no hay volumen, y sin
          volumen el flete por mar de esas piezas cuenta cero. */}
      {grupos.length > 0 && (
        <div id="medidas" className="mb-4 scroll-mt-4">
          <MedidasIA
            grupos={grupos}
            revalidate={`/presupuestos/${id}`}
            titulo="Cargar peso y medidas de este presupuesto"
          />
        </div>
      )}

      {/* Items table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="w-16 px-3 py-3" />
              <th className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Pieza
              </th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-20">
                Cant.
              </th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                P. Unit.{modoBcv && ' (BCV)'}
              </th>
              <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                Subtotal
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {items.map(item => {
              const unitPrice = aBcv(parseFloat(item.salePrice.toString()))
              const subtotal = unitPrice * item.quantity
              const bundlePieces = (item.bundleItems as BundlePiece[] | null) ?? []
              const modelo = modeloLabel(toModelIds(item.cab.compatibleModels))
              return (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-3 py-3 align-top">
                    {item.cab.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.cab.imageUrl}
                        alt={item.cab.nameEs}
                        loading="lazy"
                        className="w-12 h-12 object-contain rounded-lg border border-gray-100 bg-white"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg border border-dashed border-gray-200 bg-gray-50" />
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="text-sm font-medium text-gray-900">{item.cab.nameEs}</p>
                    {(item.cab.bajajCode || modelo) && (
                      <p className="flex items-center gap-1.5 flex-wrap">
                        {item.cab.bajajCode && (
                          <span className="text-xs font-mono text-gray-400">{item.cab.bajajCode}</span>
                        )}
                        {modelo && (
                          <span
                            title={modelo.full}
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              modelo.count === 1
                                ? 'bg-gray-100 text-gray-700 font-medium'
                                : 'bg-gray-50 text-gray-400'
                            }`}
                          >
                            {modelo.label}
                          </span>
                        )}
                      </p>
                    )}
                    {!isPresupuesto && (
                      <p className="mt-1 flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${shippingStatusMeta(item.shippingStatus).badge}`}>
                          {shippingStatusMeta(item.shippingStatus).icon} {shippingStatusMeta(item.shippingStatus).short}
                        </span>
                        {item.compradoAt && (
                          <span className="text-[10px] text-gray-400">
                            {item.origen === 'china' ? '🇨🇳' : '🇮🇳'} {item.supplier?.name ?? '99rpm'}
                          </span>
                        )}
                        {item.envioId != null && (
                          <Link href={`/envios/${item.envioId}`} className="text-[10px] text-blue-600 hover:underline">
                            envío #{item.envioId}
                          </Link>
                        )}
                        {item.envio?.guia && (
                          <span className="text-[10px] font-mono text-gray-500" title="Número de guía de la caja">
                            guía {item.envio.guia}{item.envio.transportista ? ` · ${item.envio.transportista}` : ''}
                          </span>
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
                        entregar={entregarDesdeStock.bind(null, item.id)}
                      />
                    )}
                    {isConfirmadoCliente && (
                      <IncidenciasLinea
                        itemId={item.id}
                        piezas={Array.isArray(item.bundleItems)
                          ? (item.bundleItems as unknown as BundlePiece[]).map(p => ({ etiqueta: etiquetaPieza(p), quantity: p.quantity }))
                          : undefined}
                        editarHref={`/presupuestos/${presupuesto.id}/edit`}
                        tipos={tiposPara({ shippingStatus: item.shippingStatus, costRealUsd: item.costRealUsd != null ? Number(item.costRealUsd) : null })}
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
                        <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">Recorrido ({item.etapas.length})</summary>
                        <ul className="mt-1 text-[11px] text-gray-500 space-y-0.5">
                          {item.etapas.map((e, k) => (
                            <li key={k}>
                              <span className="font-mono text-gray-400">{e.at.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })}</span>{' '}
                              {shippingStatusMeta(e.desde).short} → <strong>{shippingStatusMeta(e.hacia).short}</strong>
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
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                {groupName}
                              </p>
                            )}
                            <ul className="space-y-0.5">
                              {pieces.map((p, i) => (
                                <li key={i} className="text-xs text-gray-500">
                                  {/* Cantidad POR SET: la columna Cant. ya es el multiplicador
                                      del conjunto, mostrar el total acá lo aplicaba dos veces. */}
                                  {p.quantity}× {p.nameEs}
                                  {p.bajajCode && (
                                    <span className="ml-1.5 font-mono text-gray-300">{p.bajajCode}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-gray-700 align-top">{item.quantity}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono text-gray-700 align-top">
                    ${unitPrice.toFixed(2)}
                  </td>
                  <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-gray-900 align-top">
                    ${subtotal.toFixed(2)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Totales */}
      <div className="flex justify-end mb-4">
        <div className="w-full sm:w-80 space-y-1.5">
          <div className="flex justify-between items-baseline border-t-2 border-gray-200 pt-3">
            <span className="font-bold text-gray-900">{modoBcv ? 'Total USD (BCV)' : 'Total USD'}</span>
            <span className="font-bold text-2xl font-mono text-blue-700">${totalMostrado.toFixed(2)}</span>
          </div>
          {modoBcv && (
            <div className="text-xs text-gray-500 text-right">
              <p>Monto expresado en dólares a tasa BCV</p>
              <p>Se paga a la tasa BCV del día en que se realice el pago</p>
              {descuentoDivisasPct > 0 && <p>Pagando en divisas se aplica un descuento del {descuentoDivisasPct}%</p>}
            </div>
          )}
          {totalBsd != null && (
            <div className="flex justify-between text-sm text-gray-500">
              <span>Referencia en bolívares</span>
              <span className="font-mono">Bs {totalBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}</span>
            </div>
          )}
          {isPresupuesto && (
            <div className="flex justify-between items-center bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 mt-2">
              <span className="text-sm font-semibold text-yellow-800">Abono mínimo 50% para confirmar</span>
              <span className="font-bold font-mono text-yellow-900">${deposit.toFixed(2)}</span>
            </div>
          )}
          {isCancelado && depositUsd != null && depositUsd > 0.005 && (
            <div className="flex justify-between items-center bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
              <span className="text-sm font-semibold text-red-800">Cobrado que se quedó</span>
              <span className="font-bold font-mono text-red-900">${depositUsd.toFixed(2)}</span>
            </div>
          )}
          {!isPropio && !isPresupuesto && !isCancelado && depositUsd != null && (
            // A dólar BCV, lo cobrado y el saldo se muestran en BCV (lo que dice la tabla) y, al
            // lado, en divisas: lo guardado es real y un pago en divisas cancela el real.
            <div className="mt-2 space-y-1.5">
              <div className="flex justify-between items-center bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <span className="text-sm font-semibold text-green-800">
                  Abonado
                  {presupuesto.paymentMethod && (
                    <span className="font-normal text-green-600"> · {presupuesto.paymentMethod}</span>
                  )}
                </span>
                <span className="text-right">
                  <span className="block font-bold font-mono text-green-900">${cobro.abonadoBcv.toFixed(2)}</span>
                  {modoBcv && <span className="block text-[11px] text-green-700 font-mono">${depositUsd.toFixed(2)} en divisas</span>}
                </span>
              </div>
              <div className="flex justify-between items-center px-3">
                <span className="text-sm font-semibold text-gray-700">{saldoAFavor > 0.005 ? 'A favor del cliente' : 'Saldo pendiente'}</span>
                <span className="text-right">
                  <span className="block font-bold font-mono text-gray-900">${Math.abs(cobro.saldoBcv).toFixed(2)}</span>
                  {modoBcv && <span className="block text-[11px] text-gray-500 font-mono">${Math.abs(cobro.saldoReal).toFixed(2)} en divisas</span>}
                </span>
              </div>
              {presupuesto.depositAt && (
                <p className="text-xs text-gray-400 px-3">
                  Adelanto del {new Date(presupuesto.depositAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {incidenciasSinLinea.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-3 mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Problemas de piezas que ya no están en el pedido</h2>
          <ul className="text-xs text-gray-600 space-y-1">
            {incidenciasSinLinea.map(i => (
              <li key={i.id}>
                {TIPO_LABELS[i.tipo as keyof typeof TIPO_LABELS] ?? i.tipo} · {i.cantidad}× «{i.descripcion}»
                {i.perdidaUsd != null && Number(i.perdidaUsd) > 0 && <span className="text-red-700"> · pérdida ${Number(i.perdidaUsd).toFixed(2)}</span>}
                {i.nota && <span className="text-gray-400"> — {i.nota}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {presupuesto.eventos.length > 0 && (
        <details className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-3 mb-4">
          <summary className="text-xs font-semibold uppercase tracking-wide text-gray-500 cursor-pointer">
            Historial del pedido ({presupuesto.eventos.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {presupuesto.eventos.map(e => (
              <li key={e.id} className="text-xs text-gray-600 flex gap-3">
                <span className="font-mono text-gray-400 shrink-0 w-24">
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
      {terminos && (
        <details className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-3">
          <summary className="text-xs font-semibold uppercase tracking-wide text-gray-500 cursor-pointer">
            Términos y condiciones
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-gray-600 whitespace-pre-line">
            {terminos}
          </p>
        </details>
      )}
    </div>
  )
}
