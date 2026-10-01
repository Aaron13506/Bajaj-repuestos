import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { toConfigMap, num as cfgNum, type ConfigMap } from '@/lib/config'
import { isDelivered } from '@/lib/shipping-status'
import { calcLanded } from '@/lib/calc'
import { lookupDeConjuntos, expandCostPieces } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'

// Libro de movimientos: la fuente única de "cuánta plata tengo". Cada categoría fija su
// tipo (ver tipoDeCategoria) para que un ingreso no pueda anotarse con categoría de egreso
// ni viceversa — el formulario solo pide la categoría.
export const CATEGORIAS_INGRESO = ['adelanto_cliente', 'pago_cliente', 'otro_ingreso'] as const
// Flete separado por carril (ver lib/modo.ts): son dos costos que no se pagan al mismo
// transportista ni en el mismo momento — mezclarlos en una sola "Flete" no decía cuál caja
// lo generó cuando el egreso no queda linkeado a un envío puntual.
export const CATEGORIAS_EGRESO = [
  'pago_proveedor',
  'comision_giro',
  'flete_aereo',
  'flete_maritimo',
  'gasto_operativo',
  'otro_egreso',
] as const

export type CategoriaIngreso = (typeof CATEGORIAS_INGRESO)[number]
export type CategoriaEgreso = (typeof CATEGORIAS_EGRESO)[number]
export type Categoria = CategoriaIngreso | CategoriaEgreso

export const CATEGORIA_LABELS: Record<Categoria, string> = {
  adelanto_cliente: 'Adelanto de cliente',
  pago_cliente: 'Pago de cliente',
  otro_ingreso: 'Otro ingreso',
  pago_proveedor: 'Pago a proveedor',
  comision_giro: 'Comisión de giro',
  flete_aereo: 'Flete aéreo',
  flete_maritimo: 'Flete marítimo',
  gasto_operativo: 'Gasto operativo',
  otro_egreso: 'Otro egreso',
}

export function tipoDeCategoria(categoria: string): 'ingreso' | 'egreso' {
  return (CATEGORIAS_INGRESO as readonly string[]).includes(categoria) ? 'ingreso' : 'egreso'
}

const num = (d: Prisma.Decimal | number | null | undefined) =>
  d == null ? 0 : typeof d === 'number' ? d : parseFloat(d.toString())

// ─── Apertura de caja ────────────────────────────────────────────────────────────
//
// El saldo de caja se calcula sumando TODO el histórico de Movimiento, y ese histórico
// puede no ser confiable desde el día uno (gastos que nunca se anotaron porque esta
// función no existía). En vez de una tabla nueva o de inventar un egreso de "ajuste" en
// el libro (que ensuciaría el libro con un movimiento que no es un movimiento real), la
// apertura vive en dos keys de Config — la misma tabla que ya guarda `inr_usd_rate` y
// las tarifas de Shoppre, exactamente para este tipo de valor declarado a mano una vez.
//
// Es un ancla, no un movimiento: el libro queda 100% real (solo ingresos/egresos que
// pasaron), y el saldo mostrado es `saldoInicial + flujo real desde esa fecha`.
export interface AperturaCaja {
  desde: Date
  saldoInicial: number
}

export function aperturaCaja(cfg: ConfigMap): AperturaCaja | null {
  const rawFecha = cfg['caja_apertura_desde']?.trim()
  const rawMonto = cfg['caja_apertura_usd']?.trim()
  if (!rawFecha || !rawMonto) return null
  const desde = new Date(`${rawFecha}T00:00:00`)
  const saldoInicial = parseFloat(rawMonto)
  if (isNaN(desde.getTime()) || !Number.isFinite(saldoInicial)) return null
  return { desde, saldoInicial }
}

export interface RangoFechas {
  desde: Date
  // null = sin techo.
  hasta: Date | null
}

export interface SaldoCaja {
  ingresos: number
  egresos: number
  saldo: number
}

export async function saldoCaja(rango?: RangoFechas): Promise<SaldoCaja> {
  const where = rango
    ? { fecha: { gte: rango.desde, ...(rango.hasta ? { lt: rango.hasta } : {}) } }
    : {}
  const rows = await db.movimiento.groupBy({
    by: ['tipo'],
    where,
    _sum: { monto: true },
  })
  const ingresos = num(rows.find(r => r.tipo === 'ingreso')?._sum.monto)
  const egresos = num(rows.find(r => r.tipo === 'egreso')?._sum.monto)
  return { ingresos, egresos, saldo: ingresos - egresos }
}

export interface ValorInventario {
  valorUsd: number
  productos: number
  // Con stock pero sin landedCostUsd: no entran a la suma (no son $0, es un dato que falta).
  sinCosto: number
}

// Costo de REPOSICIÓN actual (landedCostUsd, el mismo que fija los precios de venta), no
// el costo histórico real de lo que ya está en el depósito — eso requeriría costeo por
// lote/FIFO. Ver plan: decisión explícita del usuario.
export async function valorInventario(): Promise<ValorInventario> {
  const productos = await db.product.findMany({
    where: { stock: { gt: 0 } },
    select: { stock: true, landedCostUsd: true },
  })
  let valorUsd = 0
  let sinCosto = 0
  for (const p of productos) {
    if (p.landedCostUsd == null) {
      sinCosto++
      continue
    }
    valorUsd += p.stock * num(p.landedCostUsd)
  }
  return { valorUsd, productos: productos.length, sinCosto }
}

export interface MercanciaEnCamino {
  valorUsd: number
  unidades: number
  aereo: { valorUsd: number; unidades: number; items: number }
  maritimo: { valorUsd: number; unidades: number; cajas: number }
  // Con cantidad pero sin costo (ni real ni de reposición) que valorarla: no entran a la
  // suma, igual que en valorInventario — no son $0, es un dato que falta.
  sinCosto: number
}

// Mercancía PROPIA que ya se compró (o directamente ya viaja) pero todavía no está en el
// depósito. Lo comercial (Pedido.tipo='cliente') queda afuera a propósito: ya tiene dueño
// y nunca pasa a ser stock, así que contarlo acá inflaría "lo que va a entrar al depósito"
// con piezas que van derecho a un cliente.
//
//   aéreo:     PedidoItem de un pedido 'propio' que todavía no llegó a 'entregado'. Ese es
//              el punto en el que saveItemChanges ya sumó la cantidad a Product.stock, así
//              que a partir de ahí dejó de estar "en camino" — está en el depósito.
//   marítimo:  EnvioLinea de una caja 'confirmado' (ya despachada). Una caja en 'borrador'
//              todavía se está armando —no es una compra en firme— y una 'entregado' ya
//              se sumó a stock en recibirEmbarque, así que ninguna de las dos cuenta acá.
//
// Costo del aéreo: costRealUsd si ya se cargó (el total pagado por TODA la línea, ver
// registrarCompra — no se multiplica por cantidad, ya lo incluye). Si no, se recalcula el
// landed de la línea igual que costearCarrito: expandiendo bundleItems a las piezas reales
// que lleva. Un conjunto vendido a precio único (ej. "Chain Kit") es un Product sin
// priceInr propio —es el contenedor, no algo que se compre— así que costearlo por el padre
// daba siempre $0 aunque la línea sí tuviera piezas costables adentro; esto fue justamente
// lo que dejaba "en camino" mostrando casi nada aunque hubiera cientos de dólares viajando.
//
// Costo del marítimo: landedCostUsd del producto (no hay costo real por línea — la caja se
// factura entera, ver lib/cbm.ts — y EnvioLinea no lleva bundleItems: es mercancía propia
// pieza por pieza, nunca un conjunto a precio único).
export async function mercanciaEnCamino(): Promise<MercanciaEnCamino> {
  const [itemsPropios, lineasMaritimo, configRows] = await Promise.all([
    db.pedidoItem.findMany({
      where: { pedido: { tipo: 'propio' } },
      select: {
        quantity: true,
        shippingStatus: true,
        costRealUsd: true,
        bundleItems: true,
        product: {
          select: {
            id: true, nameEs: true, bajajCode: true,
            weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
          },
        },
      },
    }),
    db.envioLinea.findMany({
      where: { envio: { modo: 'maritimo_cbm', estado: 'confirmado' } },
      select: {
        envioId: true,
        quantity: true,
        product: { select: { landedCostUsd: true } },
      },
    }),
    db.config.findMany(),
  ])

  const pendientes = itemsPropios.filter(it => !isDelivered(it.shippingStatus))
  const cfg = toConfigMap(configRows)
  // Lookup acotado a las piezas que aparecen en estos conjuntos (igual que costearCarrito).
  const lookup = await lookupDeConjuntos(pendientes.map(it => it.bundleItems as BundlePiece[] | null))

  let sinCosto = 0
  let aereoValor = 0
  let aereoUnidades = 0
  let aereoItems = 0
  for (const it of pendientes) {
    aereoUnidades += it.quantity
    let costoLinea = 0
    if (it.costRealUsd != null) {
      costoLinea = num(it.costRealUsd)
    } else {
      const piezas = expandCostPieces(it.product, it.quantity, it.bundleItems as BundlePiece[] | null, lookup)
      for (const pieza of piezas) {
        const b = calcLanded({
          priceInr: pieza.priceInr,
          weightGrams: pieza.weightGrams,
          dimL: pieza.dimL,
          dimA: pieza.dimA,
          dimH: pieza.dimH,
          margin: null,
        }, cfg, 'aereo')
        if (b == null) continue
        costoLinea += b.landedCostUsd * pieza.quantity
      }
    }
    if (costoLinea <= 0) {
      sinCosto++
      continue
    }
    aereoValor += costoLinea
    aereoItems++
  }

  let marValor = 0
  let marUnidades = 0
  const cajas = new Set<number>()
  for (const l of lineasMaritimo) {
    cajas.add(l.envioId)
    if (l.product.landedCostUsd == null) {
      sinCosto++
      continue
    }
    marValor += num(l.product.landedCostUsd) * l.quantity
    marUnidades += l.quantity
  }

  return {
    valorUsd: aereoValor + marValor,
    unidades: aereoUnidades + marUnidades,
    aereo: { valorUsd: aereoValor, unidades: aereoUnidades, items: aereoItems },
    maritimo: { valorUsd: marValor, unidades: marUnidades, cajas: cajas.size },
    sinCosto,
  }
}

export interface EnvioPendiente {
  envioId: number
  nombre: string | null
  supplierName: string
  debido: number
  pagado: number
  pendiente: number
  // Items sin costRealUsd cargado: `debido` es un piso, no el total real.
  itemsSinCosto: number
}

// Cuánto falta pagarle a cada proveedor por cada caja confirmada. Usa costRealUsd (lo que
// se pagó de verdad, PedidoItem) en vez de recalcular con calcEnvio: ese pipeline da el
// costo facturado/estimado al momento de comprar, no lo que salió de la cuenta. Los envíos
// sin proveedor (99rpm, supplierId null) no giran plata por esta vía y quedan afuera.
export async function cuentasPorPagar(): Promise<EnvioPendiente[]> {
  const envios = await db.envio.findMany({
    // No 'borrador': esa caja todavía se está armando, no es una compra en firme. Una caja
    // 'entregado' (marítima, ya recibida) SIGUE debiendo lo mismo — que ya esté en el
    // depósito no significa que ya se le pagó al proveedor.
    where: { estado: { not: 'borrador' }, supplierId: { not: null } },
    select: {
      id: true,
      nombre: true,
      tramoUsd: true,
      comisionSalienteUsd: true,
      comisionEntranteUsd: true,
      supplier: { select: { name: true } },
      items: { select: { costRealUsd: true } },
      movimientos: { where: { tipo: 'egreso' }, select: { monto: true } },
    },
  })

  return envios
    .map(e => {
      const itemsConCosto = e.items.filter(i => i.costRealUsd != null)
      const mercancia = itemsConCosto.reduce((s, i) => s + num(i.costRealUsd), 0)
      const debido = mercancia + num(e.tramoUsd) + num(e.comisionSalienteUsd) + num(e.comisionEntranteUsd)
      const pagado = e.movimientos.reduce((s, m) => s + num(m.monto), 0)
      return {
        envioId: e.id,
        nombre: e.nombre,
        supplierName: e.supplier?.name ?? '—',
        debido,
        pagado,
        pendiente: debido - pagado,
        itemsSinCosto: e.items.length - itemsConCosto.length,
      }
    })
    .filter(e => e.pendiente > 0.01 || e.itemsSinCosto > 0)
    .sort((a, b) => b.pendiente - a.pendiente)
}

export interface MovimientoRow {
  id: number
  fecha: Date
  tipo: string
  categoria: string
  monto: number
  metodoPago: string | null
  descripcion: string | null
  pedido: { id: number; clientName: string } | null
  envio: { id: number; nombre: string | null } | null
  supplier: { id: number; name: string } | null
}

export async function listarMovimientos(limit = 50, rango?: RangoFechas): Promise<MovimientoRow[]> {
  const where = rango
    ? { fecha: { gte: rango.desde, ...(rango.hasta ? { lt: rango.hasta } : {}) } }
    : {}
  const rows = await db.movimiento.findMany({
    where,
    orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
    take: limit,
    include: {
      pedido: { select: { id: true, clientName: true } },
      envio: { select: { id: true, nombre: true } },
      supplier: { select: { id: true, name: true } },
    },
  })
  return rows.map(r => ({
    id: r.id,
    fecha: r.fecha,
    tipo: r.tipo,
    categoria: r.categoria,
    monto: num(r.monto),
    metodoPago: r.metodoPago,
    descripcion: r.descripcion,
    pedido: r.pedido,
    envio: r.envio,
    supplier: r.supplier,
  }))
}

// ─── Registrar una compra (lo que se pagó de verdad por mercancía) ─────────────────
//
// costRealUsd no tiene ningún formulario que lo escriba en el resto de la app — existe en
// el schema desde antes pero nadie lo carga. Con tarjeta (99rpm) o efectivo, el monto real
// no coincide nunca con la suma exacta del catálogo (tasa del día, redondeos), así que
// pedir el precio pieza por pieza es más precisión de la que hay datos: se elige un grupo
// de ítems (uno solo o muchos, de uno o varios pedidos) y se anota el total que se pagó por
// TODOS ellos. El reparto entre piezas es proporcional al costo estimado del catálogo — un
// prorrateo, no un precio exacto — y por eso el total repartido es el único número real.
export interface ItemPendienteCosto {
  id: number
  pedidoId: number
  clientName: string
  productId: number
  nombre: string
  sku: string | null
  quantity: number
  // Estimado del catálogo (precio de proveedor si hay, si no priceInr convertido), SOLO
  // para repartir el monto real entre las piezas seleccionadas — nunca se guarda tal cual.
  // Si la línea es un conjunto (bundleItems), es la suma de las piezas reales que lleva:
  // el ensamble padre es el contenedor y no tiene priceInr propio.
  estimadoUsd: number
  // A qué caja está asignado (si alguna) y su proveedor. Sirve para dos cosas: mostrarlo
  // en el picker, y —si TODO lo seleccionado cae en la misma caja— para que el egreso que
  // se cree quede linkeado a ese envío, y así "pagado" en cuentasPorPagar lo cuente. Si la
  // selección mezcla cajas distintas (o piezas sin caja), el egreso queda sin link: no hay
  // una sola caja a la que atribuírselo entero.
  envioId: number | null
  envioNombre: string | null
  supplierId: number | null
}

async function itemsConEstimado(where: Prisma.PedidoItemWhereInput): Promise<ItemPendienteCosto[]> {
  const [items, cfgRows] = await Promise.all([
    db.pedidoItem.findMany({
      where,
      select: {
        id: true,
        quantity: true,
        supplierId: true,
        envioId: true,
        bundleItems: true,
        envio: { select: { id: true, nombre: true } },
        pedido: { select: { id: true, clientName: true } },
        product: {
          select: {
            id: true, nameEs: true, bajajCode: true, priceInr: true,
            weightGrams: true, dimL: true, dimA: true, dimH: true,
          },
        },
      },
      orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
    }),
    db.config.findMany(),
  ])
  if (items.length === 0) return []

  const cfg = toConfigMap(cfgRows)
  const inrUsd = cfgNum(cfg, 'inr_usd_rate', 95)

  // Un ítem "conjunto" (bundleItems) se expande a las piezas reales que lleva, igual que en
  // mercanciaEnCamino y costearCarrito: el producto de la línea es el ensamble (el
  // contenedor, sin priceInr propio), así que estimarlo por él daba siempre $0 aunque la
  // línea sí tuviera piezas costables adentro — y ese estimado en $0 es justo lo que
  // decide cuánto del pago real le toca a cada ítem al repartir una compra.
  const lookup = await lookupDeConjuntos(items.map(i => i.bundleItems as BundlePiece[] | null))
  const piezasPorItem = new Map(items.map(i =>
    [i.id, expandCostPieces(i.product, i.quantity, i.bundleItems as BundlePiece[] | null, lookup)]
  ))

  const supplierIds = [...new Set(items.map(i => i.supplierId).filter((x): x is number => x != null))]
  const productIds = new Set<number>()
  for (const piezas of piezasPorItem.values()) {
    for (const p of piezas) if (p.productId != null) productIds.add(p.productId)
  }
  const precios = supplierIds.length > 0 && productIds.size > 0
    ? await db.supplierPrice.findMany({
        where: { supplierId: { in: supplierIds }, productId: { in: [...productIds] } },
        select: { supplierId: true, productId: true, priceUsd: true },
      })
    : []
  const precioProveedor = new Map(precios.map(p => [`${p.supplierId}:${p.productId}`, num(p.priceUsd)]))

  return items.map(i => {
    const piezas = piezasPorItem.get(i.id)!
    const estimadoUsd = piezas.reduce((sum, pieza) => {
      const override = i.supplierId != null && pieza.productId != null
        ? precioProveedor.get(`${i.supplierId}:${pieza.productId}`)
        : undefined
      const unitUsd = override ?? (pieza.priceInr != null ? pieza.priceInr / inrUsd : 0)
      return sum + unitUsd * pieza.quantity
    }, 0)
    return {
      id: i.id,
      pedidoId: i.pedido.id,
      clientName: i.pedido.clientName,
      productId: i.product.id,
      nombre: i.product.nameEs,
      sku: i.product.bajajCode,
      quantity: i.quantity,
      estimadoUsd,
      envioId: i.envioId,
      envioNombre: i.envio?.nombre ?? null,
      supplierId: i.supplierId,
    }
  })
}

// La lista para el picker: todo lo que todavía no tiene costo real cargado, de pedidos ya
// confirmados (un presupuesto sin aprobar no se compró).
export function itemsSinCostoReal(): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ costRealUsd: null, pedido: { status: 'pedido' } })
}

// Lo mismo, pero acotado a UNA caja — para cargar el costo real desde /envios/[id] sin
// tener que ir a buscar las piezas entre todo lo pendiente. Si ya está asignado a una
// caja, el pedido ya se confirmó, así que no hace falta repetir el filtro de status.
export function itemsSinCostoRealDeEnvio(envioId: number): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ costRealUsd: null, envioId })
}

// Los mismos ítems que eligió el picker, para repartir el monto real que se cargó — se
// vuelve a calcular en vez de confiar en lo que mandó el formulario, porque el estimado
// tiene que salir siempre de la misma cuenta.
function estimarCostos(ids: number[]): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ id: { in: ids } })
}

export async function registrarCompra(
  formData: FormData,
): Promise<{ pedidoIds: number[]; envioId: number | null }> {
  const ids = formData
    .getAll('itemIds')
    .map(v => parseInt(v as string))
    .filter(Number.isFinite)
  if (ids.length === 0) return { pedidoIds: [], envioId: null }

  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return { pedidoIds: [], envioId: null }

  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  const items = await estimarCostos(ids)
  if (items.length === 0) return { pedidoIds: [], envioId: null }

  // Reparto proporcional al estimado; si ninguno tiene estimado (sin priceInr ni precio de
  // proveedor), se reparte por partes iguales en vez de dividir por cero.
  const denom = items.reduce((s, i) => s + i.estimadoUsd, 0)
  const pedidoIds = new Set(items.map(i => i.pedidoId))

  // Si TODA la selección cae en la misma caja, el egreso se linkea a ese envío (y su
  // proveedor): así "pagado" en cuentasPorPagar cuenta este pago. Si la selección mezcla
  // cajas —o trae piezas sin asignar— no hay una sola caja dueña del pago, y queda suelto
  // (sigue sumando al saldo de caja igual, solo que no a ninguna caja puntual).
  const envioIds = new Set(items.map(i => i.envioId))
  const envioUnico = envioIds.size === 1 ? items[0].envioId : null
  const supplierUnico = envioUnico != null ? items[0].supplierId : null

  await db.$transaction([
    ...items.map(i => {
      const share = denom > 0 ? i.estimadoUsd / denom : 1 / items.length
      const costRealUsd = Math.round(monto * share * 100) / 100
      return db.pedidoItem.update({ where: { id: i.id }, data: { costRealUsd } })
    }),
    db.movimiento.create({
      data: {
        fecha,
        tipo: 'egreso',
        categoria: 'pago_proveedor',
        monto,
        metodoPago,
        descripcion: descripcion ?? `Compra: ${items.length} ítem(s) en ${pedidoIds.size} pedido(s)`,
        envioId: envioUnico,
        supplierId: supplierUnico,
      },
    }),
  ])

  return { pedidoIds: [...pedidoIds], envioId: envioUnico }
}
