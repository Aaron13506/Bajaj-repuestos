import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toConfigMap, num as cfgNum, type ConfigMap } from '@/lib/config'
import { resumirCbm, costoEmbarque } from '@/lib/cbm'
import { lookupDeConjuntos, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import { ok, fallo, ErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { cobraEnBolivares } from '@/lib/pagos'
import { CUENTAS, cuentaDeMetodo, datosBs, type Cuenta, type DatosBs } from '@/lib/cuentas'
import { convertir, usdPorBsEnCuenta } from '@/lib/conversion'
import { notaCobroBcv, realDeCobro, resumenCobro } from '@/lib/cobro-bcv'
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

// Las dos patas de pasar plata de una cuenta a otra (Bs → USDT). No están en las listas de
// arriba a propósito: esas son lo que el formulario deja anotar a mano, y una pata sola
// descuadraría la caja. Se crean juntas con `registrarConversion` y se borran juntas.
export const CATEGORIAS_CONVERSION = ['conversion_salida', 'conversion_entrada'] as const

// Plata que se le devuelve a un cliente (un pedido cancelado, saldo a favor tras editarlo, un
// reembolso por una pieza). Tampoco está en las listas de lo que se anota a mano: va siempre
// ligada a su pedido y baja `depositUsd` en el mismo paso (ver `devolverACliente`); suelta,
// dejaría el pedido diciendo que el cliente sigue pagado.
export const CATEGORIAS_DEVOLUCION = ['devolucion_cliente'] as const

export type CategoriaIngreso = (typeof CATEGORIAS_INGRESO)[number]
export type CategoriaEgreso = (typeof CATEGORIAS_EGRESO)[number]
export type CategoriaConversion = (typeof CATEGORIAS_CONVERSION)[number]
export type CategoriaDevolucion = (typeof CATEGORIAS_DEVOLUCION)[number]
export type Categoria = CategoriaIngreso | CategoriaEgreso | CategoriaConversion | CategoriaDevolucion

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
  conversion_salida: 'Conversión · sale',
  conversion_entrada: 'Conversión · entra',
  devolucion_cliente: 'Devolución a cliente',
}

export function tipoDeCategoria(categoria: string): 'ingreso' | 'egreso' {
  return (CATEGORIAS_INGRESO as readonly string[]).includes(categoria) || categoria === 'conversion_entrada'
    ? 'ingreso'
    : 'egreso'
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
  /** Los bolívares que entraron y a qué tasa, si el cobro fue en Bs (ver datosBs). */
  bs?: DatosBs | null
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
      cuenta: cuentaDeMetodo(i.metodoPago),
      montoBs: i.bs?.montoBs ?? null,
      tasaBs: i.bs?.tasaBs ?? null,
    },
  })
}

export interface DevolucionPedido {
  pedidoId: number
  /** Dólares reales que salen de caja y que dejan de contar como cobrados. */
  monto: number
  fecha: Date
  metodoPago: string | null
  descripcion?: string | null
  /** Los bolívares que se entregaron y a qué tasa, si se le devolvió en Bs. */
  bs?: DatosBs | null
}

// Devolverle plata a un cliente: el egreso en el libro y la baja de `depositUsd`, juntos. El
// depósito es lo que el cliente tiene PAGADO (neto de lo devuelto), así que cobranza y clientes
// siguen leyéndolo sin cambios. Va bajo el cerrojo del pedido y rechaza devolver más de lo que
// el pedido tiene cobrado: devolver de más dejaría un depósito negativo y un libro que dice que
// salió plata que nunca entró.
export async function devolverACliente(tx: Tx, d: DevolucionPedido): Promise<void> {
  const actual = await bloquearPedido(tx, d.pedidoId)
  if (!actual) throw new ErrorDeNegocio('Ese pedido ya no existe. Recargá la página.')
  const monto = aCentavos(d.monto)
  if (!(monto > 0)) throw new ErrorDeNegocio('El monto a devolver tiene que ser mayor que 0.')
  if (monto > actual.depositUsd + 0.005) {
    throw new ErrorDeNegocio(
      `No se puede devolver $${monto.toFixed(2)}: el pedido tiene cobrado $${actual.depositUsd.toFixed(2)}.`,
    )
  }
  await ajustarDeposito(tx, d.pedidoId, -monto)
  await tx.movimiento.create({
    data: {
      fecha: d.fecha,
      tipo: 'egreso',
      categoria: 'devolucion_cliente',
      monto,
      metodoPago: d.metodoPago,
      cuenta: cuentaDeMetodo(d.metodoPago),
      descripcion: d.descripcion ?? null,
      pedidoId: d.pedidoId,
      montoBs: d.bs?.montoBs ?? null,
      tasaBs: d.bs?.tasaBs ?? null,
    },
  })
}

export interface CobroPedido extends Omit<IngresoPedido, 'bs'> {
  /** Lo que se escribió en el formulario: dólares BCV si se cobró en Bs, divisas si no. */
  monto: number
  /** Bs por dólar a los que se cobró en Bs (obligatoria con ese método, ver leerCobroBs). */
  tasaBs?: number | null
  /** Los bolívares exactos que entraron, si el formulario los trajo (si no, se calculan). */
  montoBs?: number | null
}

// El cobro de un pedido tal como se escribe en un formulario: convierte lo escrito a dólares
// REALES (lib/cobro-bcv.ts) y lo anota con `registrarIngresoPedido`, todo bajo el cerrojo del
// pedido porque un pago que cubre el saldo se guarda como el saldo real exacto. Es la ÚNICA
// puerta de un cobro con formulario: la ficha del pedido y el asiento suelto de Contabilidad
// pasan los dos por acá. Cuando el segundo guardaba el monto tal cual, un pago en Bs entraba
// en dólares BCV como si fueran reales — inflaba la caja y dejaba corto el saldo del cliente.
export async function cobrarPedido(tx: Tx, i: CobroPedido): Promise<ActionResult> {
  const actual = await bloquearPedido(tx, i.pedidoId)
  if (!actual) return fallo('Ese pedido ya no existe. Recargá la página.')
  // Un pedido cancelado ya no cobra: lo que dejó se decidió al cancelarlo (devuelto o retenido).
  if (actual.status === 'cancelado') return fallo('Ese pedido está cancelado: no se le pueden registrar cobros.')

  const p = await tx.pedido.findUniqueOrThrow({
    where: { id: i.pedidoId },
    select: { brechaEscalonPct: true, items: { select: { salePrice: true, quantity: true } } },
  })
  const escalon = p.brechaEscalonPct != null ? Number(p.brechaEscalonPct) : null
  const lineas = p.items.map(l => ({ salePrice: Number(l.salePrice), quantity: l.quantity }))
  const enBs = cobraEnBolivares(i.metodoPago)

  const r = resumenCobro(lineas, actual.depositUsd, escalon)
  const real = realDeCobro(i.monto, enBs, r, { bcv: r.saldoBcv, real: r.saldoReal })
  const nota = [i.descripcion, notaCobroBcv(i.monto, enBs, escalon)].filter(Boolean).join(' · ') || null
  const { tasaBs, montoBs, ...resto } = i
  await registrarIngresoPedido(tx, {
    ...resto, monto: real, descripcion: nota, bs: datosBs(i.metodoPago, i.monto, tasaBs ?? null, montoBs ?? null),
  })
  return ok()
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
    select: { id: true, monto: true, montoBs: true },
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
      // Los Bs bajan en la misma proporción: son los mismos bolívares, menos una parte.
      const bs = m.montoBs != null ? aCentavos(num(m.montoBs) * ((v - resta) / v)) : null
      await tx.movimiento.update({
        where: { id: m.id },
        data: { monto: aCentavos(v - resta), ...(bs != null ? { montoBs: bs } : {}) },
      })
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
  /** En qué cuenta estaba ese saldo; null = sin decir (se muestra como línea aparte). */
  cuenta: Cuenta | null
}

export function aperturaCaja(cfg: ConfigMap): AperturaCaja | null {
  const rawFecha = cfg['caja_apertura_desde']?.trim()
  const rawMonto = cfg['caja_apertura_usd']?.trim()
  if (!rawFecha || !rawMonto) return null
  const desde = new Date(`${rawFecha}T00:00:00`)
  const saldoInicial = parseFloat(rawMonto)
  if (isNaN(desde.getTime()) || !Number.isFinite(saldoInicial)) return null
  const rawCuenta = cfg['caja_apertura_cuenta']?.trim()
  const cuenta = (CUENTAS as readonly string[]).includes(rawCuenta ?? '') ? (rawCuenta as Cuenta) : null
  return { desde, saldoInicial, cuenta }
}

export interface RangoFechas {
  desde: Date
  // null = sin techo.
  hasta: Date | null
}

export interface SaldoCaja {
  ingresos: number
  egresos: number
  /**
   * Lo que costó pasar plata entre cuentas (Bs → USDT): lo que salió menos lo que entró. Es
   * costo si es positivo. Las dos patas no cuentan como ingreso ni egreso —no es plata que
   * entre ni que salga del negocio— pero el saldo sí baja por esta diferencia.
   */
  costoConversion: number
  saldo: number
}

const filtroRango = (rango?: RangoFechas) =>
  rango ? { fecha: { gte: rango.desde, ...(rango.hasta ? { lt: rango.hasta } : {}) } } : {}

export async function saldoCaja(rango?: RangoFechas): Promise<SaldoCaja> {
  const rows = await db.movimiento.groupBy({
    by: ['tipo', 'categoria'],
    where: filtroRango(rango),
    _sum: { monto: true },
  })
  const suma = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((s, r) => s + num(r._sum.monto), 0)
  const esConversion = (c: string) => (CATEGORIAS_CONVERSION as readonly string[]).includes(c)

  const ingresos = suma(r => r.tipo === 'ingreso' && !esConversion(r.categoria))
  const egresos = suma(r => r.tipo === 'egreso' && !esConversion(r.categoria))
  const costoConversion = aCentavos(
    suma(r => r.categoria === 'conversion_salida') - suma(r => r.categoria === 'conversion_entrada'),
  )
  return { ingresos, egresos, costoConversion, saldo: ingresos - egresos - costoConversion }
}

export interface SaldoDeCuenta {
  /** null = movimientos sin cuenta (sin método de pago al anotarlos). */
  cuenta: Cuenta | null
  /** Dólares reales: la suma de lo que entró menos lo que salió de esa cuenta. */
  usd: number
  /**
   * Solo en la cuenta en bolívares: los Bs que quedan según lo ANOTADO. Los movimientos de
   * antes de que se guardaran los Bs no los tienen, así que es un piso mientras `sinBs` > 0.
   */
  bs: number | null
  /** Movimientos de esta cuenta sin Bs anotados (solo se cuenta en la cuenta en Bs). */
  sinBs: number
}

// El saldo en dólares de cada cuenta, con la misma cuenta que saldoCaja (apertura aparte, la
// conversión incluida): la suma de las cuentas más la apertura es el saldo de caja.
export async function saldosPorCuenta(rango?: RangoFechas): Promise<SaldoDeCuenta[]> {
  const rows = await db.movimiento.groupBy({
    by: ['cuenta', 'tipo'],
    where: filtroRango(rango),
    _sum: { monto: true, montoBs: true },
    _count: { _all: true, montoBs: true },
  })
  const cuentas: (Cuenta | null)[] = [...CUENTAS, null]
  return cuentas
    .map((cuenta): SaldoDeCuenta => {
      const propias = rows.filter(r => r.cuenta === cuenta)
      const firmado = (f: (r: (typeof rows)[number]) => number) =>
        propias.reduce((s, r) => s + (r.tipo === 'ingreso' ? 1 : -1) * f(r), 0)
      const enBs = cuenta === 'banco_bs'
      return {
        cuenta,
        usd: aCentavos(firmado(r => num(r._sum.monto))),
        bs: enBs ? aCentavos(firmado(r => num(r._sum.montoBs))) : null,
        sinBs: enBs ? propias.reduce((s, r) => s + r._count._all - r._count.montoBs, 0) : 0,
      }
    })
    .filter(c => c.cuenta !== null || Math.abs(c.usd) > 0.005)
}

// Lo que vale hoy un bolívar del banco según el libro: el costo promedio de lo que QUEDA en la
// cuenta (ver usdPorBsEnCuenta). Null = según lo anotado no queda nada. Nunca se estima con una
// tasa de mercado: el P2P no es preciso, y lo único cierto es lo que se cobró y lo que se recibió.
export async function valorBsEnLibro(): Promise<number | null> {
  const filas = await db.movimiento.groupBy({
    by: ['tipo'],
    where: { cuenta: 'banco_bs', montoBs: { not: null } },
    _sum: { monto: true, montoBs: true },
  })
  const promedio = usdPorBsEnCuenta(filas.map(f => {
    const signo = f.tipo === 'ingreso' ? 1 : -1
    return { usd: signo * num(f._sum.monto), bs: signo * num(f._sum.montoBs) }
  }))
  return promedio
}

export interface PedidoConversion {
  /** De qué cuenta sale la plata: los Bs del banco o el efectivo en dólares. */
  desde: 'banco_bs' | 'efectivo_usd'
  /** Lo que se entregó: bolívares si sale del banco, dólares si es efectivo. */
  dado: number
  /** USDT que se recibieron. */
  usdt: number
  fecha: Date
  descripcion?: string | null
}

// Pasar plata a USDT (Bs del banco o efectivo): dos movimientos con el mismo `grupo`. La cuenta de
// origen pierde lo que el libro dice que valía lo entregado; USDT gana lo que llegó. El costo de
// convertir es la diferencia (ver lib/conversion.ts; negativo = salió a favor), y por eso no se
// anota aparte. El efectivo vale lo que dice (un dólar es un dólar). Los Bs, su costo promedio en el
// libro; si el libro no tiene con qué valorarlos (cobros anteriores a anotar los Bs), salen por lo
// que se recibió: sin costo, antes que inventarlo con una tasa de mercado.
export async function registrarConversion(p: PedidoConversion): Promise<ActionResult> {
  const enBs = p.desde === 'banco_bs'
  if (!Number.isFinite(p.dado) || p.dado <= 0) return fallo(enBs ? 'Escribí cuántos bolívares diste.' : 'Escribí cuántos dólares en efectivo diste.')
  if (!Number.isFinite(p.usdt) || p.usdt <= 0) return fallo('Escribí cuántos USDT recibiste.')

  const usdPorUnidad = enBs ? ((await valorBsEnLibro()) ?? p.usdt / p.dado) : 1
  const c = convertir(p.dado, p.usdt, usdPorUnidad)
  if (c.valorLibroUsd <= 0) return fallo('Eso vale menos de un centavo en el libro: revisá el monto.')

  const grupo = randomUUID()
  const base = { fecha: p.fecha, grupo, descripcion: p.descripcion ?? null }
  await db.$transaction([
    db.movimiento.create({
      data: {
        ...base, tipo: 'egreso', categoria: 'conversion_salida', cuenta: p.desde, monto: c.valorLibroUsd,
        ...(enBs ? { montoBs: aCentavos(p.dado), tasaBs: c.tasaEfectiva } : {}),
      },
    }),
    db.movimiento.create({
      data: { ...base, tipo: 'ingreso', categoria: 'conversion_entrada', cuenta: 'usdt', monto: c.usdt },
    }),
  ])
  return ok()
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
  cuenta: string | null
  /** Las dos patas de una conversión comparten grupo: se borran juntas. */
  grupo: string | null
  /** Bs que pasaron por la cuenta, si se anotaron. */
  montoBs: number | null
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
    cuenta: r.cuenta,
    grupo: r.grupo,
    montoBs: r.montoBs != null ? num(r.montoBs) : null,
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
  // lib/costo-envios y costearCarrito: el producto de la línea es el ensamble (el
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


// Lo que está en una caja en BORRADOR no se compra: la caja todavía no es una compra (ver
// confirmarCajaAerea). Lo de un cliente que no está en ninguna caja sí, como siempre; el stock
// propio sin caja no: es una lista de deseos hasta que entra en una caja.
const FUERA_DE_BORRADOR: Prisma.PedidoItemWhereInput = {
  OR: [
    { envioId: null, pedido: { tipo: { not: 'propio' } } },
    { envio: { estado: { not: 'borrador' } } },
  ],
}

// La lista para el picker: todo lo que todavía no tiene costo real cargado, de pedidos ya
// confirmados (un presupuesto sin aprobar no se compró).
export function itemsSinCostoReal(): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ costRealUsd: null, pedido: { status: 'pedido' }, ...FUERA_DE_BORRADOR })
}

// Lo mismo, pero acotado a UNA caja — para cargar el costo real desde /envios/[id] sin
// tener que ir a buscar las piezas entre todo lo pendiente. El filtro de status va igual: a una
// caja también entran presupuestos sin aprobar (ver assignPedido), y eso no se compra.
export function itemsSinCostoRealDeEnvio(envioId: number): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ costRealUsd: null, envioId, pedido: { status: 'pedido' }, ...FUERA_DE_BORRADOR })
}

// Los mismos ítems que eligió el picker, para repartir el monto real que se cargó — se
// vuelve a calcular en vez de confiar en lo que mandó el formulario, porque el estimado
// tiene que salir siempre de la misma cuenta.
//
// Con `costRealUsd: null` y pedido confirmado, igual que la lista que ve el picker. Sin esos
// filtros la acción aceptaba cualquier id: una pestaña vieja o un reenvío re-registraba como
// "pendiente" algo que ya tenía su costo real (y lo pisaba), o le cargaba costo a un pedido que se
// canceló mientras la lista estaba abierta.
function estimarCostos(ids: number[]): Promise<ItemPendienteCosto[]> {
  return itemsConEstimado({ id: { in: ids }, costRealUsd: null, pedido: { status: 'pedido' }, ...FUERA_DE_BORRADOR })
}

export type ResultadoCompra =
  | { ok: true; pedidoIds: number[]; envioId: number | null }
  | { ok: false; error: string }

// Señal interna para abortar la transacción de registrarCompra (y con ella el egreso).
class CompraObsoleta extends Error {}

const MSG_COMPRA_OBSOLETA =
  'Algunas de esas piezas ya tienen su costo real cargado (o ya no existen, o su pedido se canceló), así que no se anotó nada. ' +
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

  const enBorrador = await db.pedidoItem.count({ where: { id: { in: ids }, envio: { estado: 'borrador' } } })
  if (enBorrador > 0) return fallo('Hay piezas en una caja en borrador: confirmá la caja antes de registrar la compra.')

  // Una pieza que el proveedor no tiene no se compra: primero se cambia o se saca del pedido.
  const noDisponibles = await db.incidencia.findMany({
    where: { itemId: { in: ids }, estado: 'abierta', tipo: 'no_disponible' },
    select: { descripcion: true, pedidoId: true },
  })
  if (noDisponibles.length > 0) {
    const lista = noDisponibles.slice(0, 3).map(n => `«${n.descripcion}» (pedido #${n.pedidoId})`).join(', ')
    return fallo(
      `Hay piezas marcadas como no disponibles: ${lista}${noDisponibles.length > 3 ? '…' : ''}. ` +
      `Editá el pedido para cambiar o quitar esa pieza (o resolvé el problema) antes de registrar la compra.`,
    )
  }

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
      const mov = await tx.movimiento.create({
        data: {
          fecha,
          tipo: 'egreso',
          categoria: 'pago_proveedor',
          monto,
          metodoPago,
          cuenta: cuentaDeMetodo(metodoPago),
          descripcion: descripcion ?? `Compra: ${items.length} ítem(s) en ${pedidoIds.size} pedido(s)`,
          envioId: envioUnico,
          supplierId: supplierUnico,
        },
        select: { id: true },
      })

      // Los costos se escriben con UNA sentencia y condicionados a `costRealUsd IS NULL`: si
      // dos requests compiten (doble envío, dos pestañas), la segunda espera a la primera,
      // ya no encuentra esas filas vacías y actualiza menos de las pedidas. Ahí se aborta la
      // transacción entera, y con ella el egreso — el pago no se anota dos veces. Cada línea
      // guarda el egreso que la pagó: borrarlo deshace la compra (ver eliminarMovimiento).
      const valores = Prisma.join(items.map((it, k) => Prisma.sql`(${it.id}::int, ${costos[k]}::numeric)`))
      const n = await tx.$executeRaw`
        UPDATE "PedidoItem" AS pi
        SET "costRealUsd" = v.costo, "compraId" = ${mov.id}
        FROM (VALUES ${valores}) AS v(id, costo)
        WHERE pi."id" = v.id AND pi."costRealUsd" IS NULL`
      if (n !== items.length) throw new CompraObsoleta()
    }, { maxWait: 10_000, timeout: 20_000 })
  } catch (e) {
    if (e instanceof CompraObsoleta) return fallo(MSG_COMPRA_OBSOLETA)
    throw e
  }

  return { ok: true, pedidoIds: [...pedidoIds], envioId: envioUnico }
}
