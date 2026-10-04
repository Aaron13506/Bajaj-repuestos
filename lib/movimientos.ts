import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toConfigMap, num as cfgNum, type ConfigMap } from '@/lib/config'
import { isBought, isDelivered } from '@/lib/shipping-status'
import { calcLanded } from '@/lib/calc'
import { resumirCbm, costoEmbarque } from '@/lib/cbm'
import { lookupDeConjuntos, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import { fallo } from '@/lib/action-result'
import { repartirEnCentavos } from '@/lib/reparto-compra'

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

// Los egresos que SALDAN lo que se le debe al proveedor de una caja: la mercancía (y el
// tramo que él factura) y la comisión del giro con el que se le pagó. El flete se le paga a
// otro —Shoppre, la naviera—, no a él: contarlo como pagado le descontaba deuda que sigue
// viva. Es la única definición de "pagado al proveedor"; la usan cuentasPorPagar y la ficha
// de la caja, que si no podían discrepar sobre el mismo número.
export const CATEGORIAS_PAGO_PROVEEDOR = ['pago_proveedor', 'comision_giro'] as const

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

const aCentavos = (n: number) => Math.round(n * 100) / 100

// ─── Ingresos de un pedido y su caché `Pedido.depositUsd` ────────────────────────────
//
// `depositUsd` es una CACHÉ de "total cobrado hasta ahora" (ver Pedido en el schema): el
// libro es la fuente de verdad y todo lo que ya lee el depósito (cobranza, totales del
// cliente) depende de que los dos digan lo mismo. Por eso hay UN solo lugar que mueve
// ambos, y todas las acciones que cobran, corrigen o borran un ingreso de un pedido pasan
// por acá. Cuando cada una hacía lo suyo, un ingreso cargado desde Contabilidad no sumaba
// al depósito, pero borrarlo sí lo restaba, y la corrección a la baja de un adelanto
// dejaba el libro inflado.
//
// Todo va dentro de la `tx` que pasa el llamador: el movimiento y la caché se mueven juntos
// o no se mueven.
type Tx = Prisma.TransactionClient

// Suma `delta` (+ o −) a depositUsd en UNA sentencia, y no leyendo el valor para escribirlo
// después: con dos cobros simultáneos, "leer, sumar, escribir" pisa uno. `COALESCE` porque
// el depósito de un pedido sin cobros es NULL, y NULL + x es NULL. Un saldo que queda en
// cero (o en un resto de redondeo) vuelve a NULL, igual que un pedido que nunca cobró.
export async function ajustarDeposito(tx: Tx, pedidoId: number, delta: number) {
  const d = aCentavos(delta)
  const filas = await tx.$executeRaw`
    UPDATE "Pedido"
    SET "depositUsd" = CASE
          WHEN COALESCE("depositUsd", 0) + ${d}::numeric > 0.01
          THEN COALESCE("depositUsd", 0) + ${d}::numeric
          ELSE NULL
        END,
        "updatedAt" = NOW()
    WHERE "id" = ${pedidoId}`
  if (filas === 0) throw new Error(`El pedido #${pedidoId} no existe.`)
}

// Toma el cerrojo de la fila del pedido y devuelve lo que tiene AHORA. Quien va a decidir
// algo a partir del depósito (cuánto es el delta de un adelanto editado) tiene que leerlo
// con esto y no con un findUnique suelto: sin el cerrojo, otra request puede cobrar entre la
// lectura y la escritura y el delta se calcula contra un número que ya no es. De paso
// serializa a las que compiten por el mismo pedido, así que un doble envío de la misma
// edición ve el resultado de la primera y no hace nada. Siempre se toma ANTES de tocar
// movimientos de ese pedido: con el mismo orden en todas las acciones no hay interbloqueo.
export async function bloquearPedido(
  tx: Tx,
  pedidoId: number,
): Promise<{ status: string; depositUsd: number } | null> {
  const filas = await tx.$queryRaw<{ status: string; depositUsd: Prisma.Decimal | null }[]>`
    SELECT "status", "depositUsd" FROM "Pedido" WHERE "id" = ${pedidoId} FOR UPDATE`
  if (filas.length === 0) return null
  return { status: filas[0].status, depositUsd: num(filas[0].depositUsd) }
}

export interface IngresoPedido {
  pedidoId: number
  monto: number
  categoria: string
  fecha: Date
  metodoPago: string | null
  descripcion?: string | null
  // Un cobro es del cliente y normalmente no lleva caja ni proveedor, pero el asiento suelto
  // de Contabilidad deja ligarlos y se respeta lo que mande.
  envioId?: number | null
  supplierId?: number | null
}

// Un cobro de un pedido: el movimiento en el libro y el aumento del depósito, juntos.
export async function registrarIngresoPedido(tx: Tx, i: IngresoPedido) {
  await ajustarDeposito(tx, i.pedidoId, i.monto)
  await tx.movimiento.create({
    data: {
      fecha: i.fecha,
      tipo: 'ingreso',
      categoria: i.categoria,
      monto: i.monto,
      metodoPago: i.metodoPago,
      descripcion: i.descripcion ?? null,
      pedidoId: i.pedidoId,
      envioId: i.envioId ?? null,
      supplierId: i.supplierId ?? null,
    },
  })
}

// Corrección a la BAJA de lo cobrado (se cargó $1000 por error y era $100): saca `monto` de
// los ingresos del pedido, del más reciente al más viejo, borrando los que quedan en cero y
// recortando el último. No anota un egreso: en esa pantalla "editar adelanto" corrige un
// dato, no devuelve plata, así que el movimiento equivocado no tiene que seguir en el libro
// — si se dejara y el depósito bajara, el saldo de caja quedaría inflado para siempre. Una
// devolución real al cliente es otro hecho y se anota como un egreso aparte.
//
// Devuelve cuánto pudo descontar: menos que `monto` solo si el libro tenía menos ingresos de
// los que decía la caché (un desfase heredado), caso en que no hay más que corregir.
export async function descontarIngresosPedido(tx: Tx, pedidoId: number, monto: number): Promise<number> {
  const ingresos = await tx.movimiento.findMany({
    where: { pedidoId, tipo: 'ingreso' },
    orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
    select: { id: true, monto: true },
  })
  let resta = aCentavos(monto)
  let descontado = 0
  for (const m of ingresos) {
    if (resta < 0.005) break
    const v = num(m.monto)
    if (v <= resta + 0.005) {
      await tx.movimiento.delete({ where: { id: m.id } })
      resta = aCentavos(resta - v)
      descontado += v
    } else {
      await tx.movimiento.update({ where: { id: m.id }, data: { monto: aCentavos(v - resta) } })
      descontado += resta
      resta = 0
    }
  }
  return aCentavos(descontado)
}

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
//   aéreo:     PedidoItem de un pedido 'propio' que YA se compró (isBought) y todavía no llegó
//              a 'entregado'. Ese es el punto en el que saveItemChanges ya sumó la cantidad a
//              Product.stock, así que a partir de ahí dejó de estar "en camino" — está en el
//              depósito. Una línea en 'pendiente' es una intención: un pedido propio recién
//              creado nace con todas sus líneas ahí y sumaba como mercancía viajando.
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

  const pendientes = itemsPropios.filter(it => isBought(it.shippingStatus) && !isDelivered(it.shippingStatus))
  const cfg = toConfigMap(configRows)
  // Lookup acotado a las piezas que aparecen en estos conjuntos (igual que costearCarrito).
  const lookup = await lookupDeConjuntos(pendientes.map(it => it.bundleItems as BundlePiece[] | null))

  let sinCosto = 0
  let aereoValor = 0
  let aereoUnidades = 0
  let aereoItems = 0
  for (const it of pendientes) {
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
    // Las unidades se cuentan solo si la línea entra a la suma, igual que en el marítimo:
    // una línea sin costo ya figura en `sinCosto`, y contarla acá hacía que "unidades" y
    // "valor" hablaran de conjuntos distintos.
    aereoUnidades += it.quantity
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
  // Items sin costRealUsd cargado (aéreo) o piezas sin precio (marítimo): `debido` es un
  // piso, no el total real.
  itemsSinCosto: number
}

export interface CuentasPorPagar {
  /** Cajas con algo por pagarle al proveedor, o cuyo debido todavía es un piso. */
  pendientes: EnvioPendiente[]
  /**
   * Cajas a las que se les pagó MÁS de lo debido, con el debido ya completo. Va aparte: un
   * pendiente negativo no es "cero por pagar", es plata que salió de más (o un costo mal
   * cargado) y hay que verla; escondida en el listado desaparecía justo lo que alertaba.
   */
  sobrepagadas: EnvioPendiente[]
}

// Cuánto falta pagarle a cada proveedor por cada caja confirmada.
//
// DEBIDO — lo que esa caja le debe al proveedor, por carril:
//   aéreo:    costRealUsd de los ítems (lo que se pagó de verdad, PedidoItem) + el total
//             que facturó por el tramo a USA + las comisiones del giro. Se usa el real y no
//             calcEnvio: ese pipeline da el costo estimado al comprar, no lo que salió de
//             la cuenta.
//   marítimo: la mercancía + el FOB, que es lo que el proveedor cobra por liberar la carga
//             (`giroUsd` en costoEmbarque), + las comisiones. El flete por m³ NO entra: lo
//             cobra la naviera. El marítimo no tiene costRealUsd por línea (EnvioLinea es
//             producto y cantidad), así que su mercancía sale del precio del proveedor de la
//             caja o, si no lo tiene, del catálogo — el mismo costeo que muestra su ficha.
//             Sin esta rama el marítimo no figuraba nunca como deuda.
//
// PAGADO — solo los egresos de CATEGORIAS_PAGO_PROVEEDOR. Los fletes se le pagan a otro.
//
// Los envíos sin proveedor (99rpm, supplierId null) no giran plata por esta vía y quedan
// afuera.
export async function cuentasPorPagar(): Promise<CuentasPorPagar> {
  const [envios, cfgRows] = await Promise.all([
    db.envio.findMany({
      // No 'borrador': esa caja todavía se está armando, no es una compra en firme. Una caja
      // 'entregado' (marítima, ya recibida) SIGUE debiendo lo mismo — que ya esté en el
      // depósito no significa que ya se le pagó al proveedor.
      where: { estado: { not: 'borrador' }, supplierId: { not: null } },
      select: {
        id: true,
        nombre: true,
        modo: true,
        supplierId: true,
        tramoUsd: true,
        comisionSalienteUsd: true,
        comisionEntranteUsd: true,
        supplier: { select: { name: true, fobUsd: true } },
        items: { select: { costRealUsd: true } },
        lineas: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            product: {
              select: {
                id: true, nameEs: true, bajajCode: true,
                weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
              },
            },
          },
        },
        movimientos: {
          where: { tipo: 'egreso', categoria: { in: [...CATEGORIAS_PAGO_PROVEEDOR] } },
          select: { monto: true },
        },
      },
    }),
    db.config.findMany(),
  ])

  const cfg = toConfigMap(cfgRows)

  // Precios de proveedor solo de lo que viaja por mar: es lo único que los necesita, y
  // acotarlos a (proveedor, pieza) evita traer la lista entera de cada uno.
  const maritimas = envios.filter(e => e.modo === 'maritimo_cbm')
  const precios = maritimas.length > 0
    ? await db.supplierPrice.findMany({
        where: {
          supplierId: { in: [...new Set(maritimas.map(e => e.supplierId!))] },
          productId: { in: [...new Set(maritimas.flatMap(e => e.lineas.map(l => l.productId)))] },
        },
        select: { supplierId: true, productId: true, priceUsd: true, isLanded: true },
      })
    : []

  const filas = envios.map((e): EnvioPendiente => {
    let mercancia: number
    let itemsSinCosto: number

    if (e.modo === 'maritimo_cbm') {
      const priceMap = new Map(
        precios
          .filter(p => p.supplierId === e.supplierId)
          .map(p => [p.productId, { priceUsd: num(p.priceUsd), isLanded: p.isLanded }]),
      )
      const fob = e.supplier?.fobUsd != null ? num(e.supplier.fobUsd) : null
      const resumen = resumirCbm(
        e.lineas.map(l => ({
          itemId: l.id, pedidoId: 0, productId: l.productId, quantity: l.quantity,
          salePrice: 0, bundleItems: null, product: l.product as ProductCost,
        })),
        () => undefined,
        cfg,
        { priceMap, fobUsd: fob },
      )
      mercancia = e.lineas.length > 0
        ? costoEmbarque(resumen.volumeM3, cfg, fob, { mercanciaUsd: resumen.costoOrigenUsd }).giroUsd
        : 0
      itemsSinCosto = resumen.piezas.filter(p => p.sinPrecio).length
    } else {
      const itemsConCosto = e.items.filter(i => i.costRealUsd != null)
      mercancia = itemsConCosto.reduce((s, i) => s + num(i.costRealUsd), 0)
      itemsSinCosto = e.items.length - itemsConCosto.length
    }

    const debido = mercancia + num(e.tramoUsd) + num(e.comisionSalienteUsd) + num(e.comisionEntranteUsd)
    const pagado = e.movimientos.reduce((s, m) => s + num(m.monto), 0)
    return {
      envioId: e.id,
      nombre: e.nombre,
      supplierName: e.supplier?.name ?? '—',
      debido,
      pagado,
      pendiente: debido - pagado,
      itemsSinCosto,
    }
  })

  return {
    pendientes: filas
      .filter(f => f.pendiente > 0.01 || f.itemsSinCosto > 0)
      .sort((a, b) => b.pendiente - a.pendiente),
    // Con piezas sin costo el debido es un piso: haber pagado "de más" contra un piso no
    // prueba nada todavía, así que esas cajas siguen en pendientes.
    sobrepagadas: filas
      .filter(f => f.pendiente < -0.01 && f.itemsSinCosto === 0)
      .sort((a, b) => a.pendiente - b.pendiente),
  }
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
        ensamble: { select: { nameEs: true, nameEn: true } },
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
      // Una línea es una pieza o un conjunto (CHECK PedidoItem_pieza_xor_conjunto): un
      // conjunto no tiene código propio, solo el nombre del ensamble.
      nombre: i.product?.nameEs ?? (i.ensamble ? nombreEnsamble(i.ensamble) : ''),
      sku: i.product?.bajajCode ?? null,
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
//
// Con `costRealUsd: null`, igual que la lista que ve el picker. Sin ese filtro la acción
// aceptaba cualquier id: una pestaña vieja o un reenvío re-registraba como "pendiente" algo
// que ya tenía su costo real, y lo pisaba.
function estimarCostos(ids: number[]): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ id: { in: ids }, costRealUsd: null })
}

export type ResultadoCompra =
  | { ok: true; pedidoIds: number[]; envioId: number | null }
  | { ok: false; error: string }

// Señal interna para abortar la transacción de registrarCompra (y con ella el egreso).
class CompraObsoleta extends Error {}

const MSG_COMPRA_OBSOLETA =
  'Algunas de esas piezas ya tienen su costo real cargado (o ya no existen), así que no se anotó nada. ' +
  'La lista que estás viendo quedó vieja: recargá la página para ver lo que sigue pendiente.'

export async function registrarCompra(formData: FormData): Promise<ResultadoCompra> {
  const ids = [...new Set(
    formData
      .getAll('itemIds')
      .map(v => parseInt(v as string))
      .filter(Number.isFinite),
  )]
  if (ids.length === 0) return fallo('Elegí al menos una pieza.')

  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El total pagado tiene que ser mayor a 0.')

  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  const items = await estimarCostos(ids)
  // Menos piezas de las pedidas = alguna ya tenía costo real (o no existe). Seguir con las
  // que sí quedan repartiría el monto entero —que era por TODAS— entre unas pocas.
  if (items.length !== ids.length) return fallo(MSG_COMPRA_OBSOLETA)

  // Reparto proporcional al estimado, en centavos exactos: lo repartido suma el total pagado
  // al centavo (ver repartirEnCentavos). Sin estimado en ninguna, a partes iguales.
  const costos = repartirEnCentavos(monto, items.map(i => i.estimadoUsd))
  const pedidoIds = new Set(items.map(i => i.pedidoId))

  // Si TODA la selección cae en la misma caja, el egreso se linkea a ese envío (y su
  // proveedor): así "pagado" en cuentasPorPagar cuenta este pago. Si la selección mezcla
  // cajas —o trae piezas sin asignar— no hay una sola caja dueña del pago, y queda suelto
  // (sigue sumando al saldo de caja igual, solo que no a ninguna caja puntual).
  const envioIds = new Set(items.map(i => i.envioId))
  const envioUnico = envioIds.size === 1 ? items[0].envioId : null
  const supplierUnico = envioUnico != null ? items[0].supplierId : null

  try {
    await db.$transaction(async tx => {
      // Los costos se escriben con UNA sentencia y condicionados a `costRealUsd IS NULL`: si
      // dos requests compiten (doble envío, dos pestañas), la segunda espera a la primera,
      // ya no encuentra esas filas vacías y actualiza menos de las pedidas. Ahí se aborta la
      // transacción entera, y con ella el egreso — el pago no se anota dos veces.
      const valores = Prisma.join(items.map((it, k) => Prisma.sql`(${it.id}::int, ${costos[k]}::numeric)`))
      const n = await tx.$executeRaw`
        UPDATE "PedidoItem" AS pi
        SET "costRealUsd" = v.costo
        FROM (VALUES ${valores}) AS v(id, costo)
        WHERE pi."id" = v.id AND pi."costRealUsd" IS NULL`
      if (n !== items.length) throw new CompraObsoleta()

      await tx.movimiento.create({
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
      })
    }, { maxWait: 10_000, timeout: 20_000 })
  } catch (e) {
    if (e instanceof CompraObsoleta) return fallo(MSG_COMPRA_OBSOLETA)
    throw e
  }

  return { ok: true, pedidoIds: [...pedidoIds], envioId: envioUnico }
}
