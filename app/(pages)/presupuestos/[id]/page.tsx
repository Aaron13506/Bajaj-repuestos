import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import PresupuestoPdfButton from '@/components/PresupuestoPdfButton'
import AprobarPedidoForm from '@/components/AprobarPedidoForm'
import RegistrarPagoClienteForm from '@/components/RegistrarPagoClienteForm'
import MedidasIA, { type GrupoMedidas, type PiezaMedible } from '@/components/MedidasIA'
import { deletePresupuesto, aprobarPedido, registrarPagoPedido } from '../actions'
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

export default async function PresupuestoDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
              },
            },
            ensamble: { select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true } },
            supplier: { select: { name: true } },
          },
          orderBy: { id: 'asc' },
        },
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
  const isPresupuesto = presupuesto.status === 'presupuesto'
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
  const compra = stageSummary(presupuesto.items)

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
  const escalon = isPropio
    ? null
    : isPresupuesto
      ? escalonBcvVigente(cfg)
      : presupuesto.brechaEscalonPct != null ? Number(presupuesto.brechaEscalonPct) : null
  const modoBcv = escalon != null
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

  const bsdRate = bsdRow ? parseFloat(bsdRow.value) : NaN
  // A dólar BCV no se muestra equivalente en Bs: la tasa del día no es la del pago y confunde.
  const totalBsd = modoBcv || Number.isNaN(bsdRate) ? null : total * bsdRate
  // Abono sugerido: 50% en las dos monedas en que se puede cobrar (el form elige según el método).
  const deposit = Math.round(cobro.totalBcv * 50) / 100
  const depositDivisas = Math.round(cobro.totalReal * 50) / 100
  const depositDateStr = presupuesto.depositAt
    ? new Date(presupuesto.depositAt).toISOString().slice(0, 10)
    : null

  const created = new Date(presupuesto.createdAt)
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })
  const fecha = fmtDate(created)
  const validez = fmtDate(new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000))
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
            <Link href="/presupuestos" className="text-gray-400 hover:text-gray-600 text-sm">
              Presupuestos
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
                : isPresupuesto
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-green-100 text-green-700'
            }`}>
              {isPropio ? 'Stock propio' : isPresupuesto ? 'Presupuesto' : 'Pedido confirmado'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {!isPropio && isPresupuesto && (
            <>
              <div className="relative">
                <AprobarPedidoForm
                  action={aprobarPedido.bind(null, id)}
                  methods={METODOS_PAGO_INGRESO}
                  montos={{ bs: deposit, divisas: depositDivisas }}
                  modoBcv={modoBcv}
                />
              </div>
              <Link
                href={`/presupuestos/${id}/edit`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Editar
              </Link>
            </>
          )}
          {!isPropio && !isPresupuesto && (
            <div className="relative flex items-center gap-2">
              <RegistrarPagoClienteForm
                action={registrarPagoPedido.bind(null, id)}
                methods={METODOS_PAGO_INGRESO}
                modoBcv={modoBcv}
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
          <PresupuestoPdfButton fileName={fileName} data={pdfData} />
          {noEliminable ? (
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

      {/* Client info */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
        <div className="flex justify-between text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Cliente</p>
            <p className="font-semibold text-gray-900 text-base">{presupuesto.clientName}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Fecha</p>
            <p className="text-gray-700">{fecha}</p>
            {isPresupuesto && (
              <p className="text-xs text-gray-400 mt-1">Válido hasta {validez}</p>
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

      {/* Estado de compra — derivado de los ítems, no del pedido: de un mismo
          presupuesto unas piezas pueden estar compradas y otras no. */}
      {!isPresupuesto && compra && (
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
                      </p>
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
          {!isPropio && !isPresupuesto && depositUsd != null && (
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
                <span className="text-sm font-semibold text-gray-700">Saldo pendiente</span>
                <span className="text-right">
                  <span className="block font-bold font-mono text-gray-900">${cobro.saldoBcv.toFixed(2)}</span>
                  {modoBcv && <span className="block text-[11px] text-gray-500 font-mono">${cobro.saldoReal.toFixed(2)} en divisas</span>}
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
