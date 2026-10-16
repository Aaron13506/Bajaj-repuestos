import { db } from '@/lib/db'
import { costearAereo, contextoCosteo, ENVIO_COSTEO_INCLUDE } from '@/lib/costo-envios'
import {
  margenDePedido, resultadoPorMes,
  type CancelacionResultado, type LineaMargen, type MargenPedido, type MesResultado,
} from '@/lib/margen'
import { isDelivered } from '@/lib/shipping-status'

// Lo que se necesita saber de un pedido para decir cuánto se ganó con él, leído de la base.
// La cuenta es de lib/margen.ts (pura); acá solo se juntan los datos.
//
// El costo de cada línea sale del MISMO costeo que muestra la ficha de su caja (`costearAereo`),
// no de uno propio: un margen calculado con otra cuenta no coincidiría con ninguna pantalla.
// Una venta del depósito trae su costo congelado en `costRealUsd` (ver lib/venta-stock.ts).

const dec = (v: { toString(): string } | null | undefined) => (v != null ? parseFloat(v.toString()) : null)

export interface FilaMargen {
  pedidoId: number
  clientName: string
  clienteId: number | null
  tipo: string
  createdAt: Date
  margen: MargenPedido
  /** Cuándo cuenta para el resultado del mes: la entrega, o hoy si todavía no se entregó. */
  fecha: Date
}

// Solo los pedidos que son una venta: de cliente ya confirmados, y las ventas del depósito.
// El stock propio no se vende por este camino y un presupuesto sin aprobar todavía no es nada.
export async function cargarMargenes(pedidoIds?: number[]): Promise<FilaMargen[]> {
  const pedidos = await db.pedido.findMany({
    where: {
      status: 'pedido',
      tipo: { in: ['cliente', 'venta'] },
      ...(pedidoIds ? { id: { in: pedidoIds } } : {}),
    },
    select: {
      id: true, clientName: true, clienteId: true, tipo: true, createdAt: true,
      items: {
        select: {
          id: true, quantity: true, salePrice: true, envioId: true, costRealUsd: true,
          shippingStatus: true, shippingStatusAt: true,
        },
      },
    },
    orderBy: { id: 'desc' },
  })

  // Lo perdido en piezas reembolsadas: costo del pedido que ya no está en ninguna línea.
  const ids = pedidos.map(p => p.id)
  const [perdidasRows, brechas] = ids.length > 0
    ? await Promise.all([
        db.incidencia.groupBy({
          by: ['pedidoId'],
          where: { pedidoId: { in: ids }, resolucion: 'reembolso', perdidaUsd: { not: null } },
          _sum: { perdidaUsd: true },
          _max: { resueltaAt: true },
        }),
        brechaPorPedido(ids),
      ])
    : [[], new Map<number, number>()]
  const perdidasDe = new Map(perdidasRows.map(r => [r.pedidoId, { perdidasUsd: dec(r._sum.perdidaUsd) ?? 0, ultimaAt: r._max.resueltaAt }]))

  const envioIds = [...new Set(pedidos.flatMap(p => p.items.flatMap(i => (i.envioId != null ? [i.envioId] : []))))]
  const envios = envioIds.length > 0
    ? await db.envio.findMany({ where: { id: { in: envioIds } }, include: ENVIO_COSTEO_INCLUDE })
    : []
  const ctx = await contextoCosteo(envios)

  // Por línea de pedido: lo que cuesta puesta acá, y si ese costo es el real.
  const costoDeItem = new Map<number, { costoUsd: number; real: boolean }>()
  for (const e of envios) {
    if (e.modo === 'maritimo_cbm') continue
    const { calc, itemIdDeLinea } = costearAereo(e, ctx)
    // La caja está cerrada en números cuando se pesó, y cada carrier facturó su tramo. Sin eso
    // el flete que se le reparte a las líneas es el de tabla.
    const flete = calc.tramo ? calc.tramo.faltaCosto !== true : e.shippingCostRealAereo != null
    const cajaReal = calc.caja.medido && flete && e.shippingCostRealMaritimo != null && !calc.lines.some(l => l.missingWeight)
    const porItem = new Map<number, number>()
    calc.lines.forEach((l, k) => porItem.set(itemIdDeLinea[k], (porItem.get(itemIdDeLinea[k]) ?? 0) + l.landedUsd))
    for (const it of e.items) {
      costoDeItem.set(it.id, { costoUsd: porItem.get(it.id) ?? 0, real: cajaReal && it.costRealUsd != null })
    }
  }

  return pedidos.map(p => {
    const lineas: LineaMargen[] = p.items.map(i => {
      const costoReal = dec(i.costRealUsd)
      let costo: { costoUsd: number; real: boolean } | null = null
      if (p.tipo === 'venta') {
        // Lo que costaba lo vendido, congelado al vender.
        costo = costoReal != null ? { costoUsd: costoReal, real: true } : null
      } else if (i.envioId != null) {
        costo = costoDeItem.get(i.id) ?? null
      } else if (costoReal != null) {
        // Una pieza que el proveedor entregó puesta (landed) sin pasar por una caja: su costo es
        // lo que se pagó por ella.
        costo = { costoUsd: costoReal, real: true }
      }
      return {
        ventaUsd: parseFloat(i.salePrice.toString()) * i.quantity,
        costoUsd: costo?.costoUsd ?? null,
        costoReal: costo?.real ?? false,
        entregada: isDelivered(i.shippingStatus),
        entregadaAt: i.shippingStatusAt,
      }
    })
    const margen = margenDePedido(lineas, {
      ...(perdidasDe.get(p.id) ?? { perdidasUsd: 0, ultimaAt: null }),
      brechaUsd: brechas.get(p.id) ?? 0,
    })
    return {
      pedidoId: p.id,
      clientName: p.clientName,
      clienteId: p.clienteId,
      tipo: p.tipo,
      createdAt: p.createdAt,
      margen,
      fecha: margen.entregadoAt ?? p.createdAt,
    }
  })
}

// Lo que la brecha movió en los cobros de cada pedido (Movimiento 'diferencia_brecha').
async function brechaPorPedido(pedidoIds: number[]): Promise<Map<number, number>> {
  const rows = await db.movimiento.groupBy({
    by: ['pedidoId'],
    where: { pedidoId: { in: pedidoIds }, categoria: 'diferencia_brecha' },
    _sum: { monto: true },
  })
  return new Map(rows.map(r => [r.pedidoId!, dec(r._sum.monto) ?? 0]))
}

// El resultado de cada mes: margen de lo entregado menos los gastos propios del negocio y lo que
// costó pasar Bs a USDT. Ver resultadoPorMes para qué entra y qué no.
export async function resultadosMensuales(filas: FilaMargen[]): Promise<MesResultado[]> {
  const [movs, canceladas] = await Promise.all([
    db.movimiento.findMany({
      where: { categoria: { in: ['gasto_operativo', 'otro_egreso', 'conversion_salida', 'conversion_entrada'] } },
      select: { fecha: true, categoria: true, monto: true },
    }),
    cargarCancelaciones(),
  ])
  return resultadoPorMes(
    filas.map(f => ({ margen: f.margen, fecha: f.fecha })),
    movs.map(m => ({ fecha: m.fecha, categoria: m.categoria, monto: parseFloat(m.monto.toString()) })),
    canceladas.map((c): CancelacionResultado => ({ fecha: c.fecha, retenidoUsd: c.retenidoUsd })),
  )
}

export interface FilaCancelacion {
  pedidoId: number
  clientName: string
  clienteId: number | null
  fecha: Date
  motivo: string | null
  /** Lo cobrado que se quedó: el depósito que sigue en el pedido después de lo devuelto. */
  retenidoUsd: number
}

// Los pedidos cancelados que dejaron plata. Lo comprado de un pedido cancelado no es pérdida:
// pasó a stock propio con su costo (ver cancelarPedido), así que lo único que cuenta acá es lo
// que el cliente dejó y no se le devolvió.
export async function cargarCancelaciones(): Promise<FilaCancelacion[]> {
  const rows = await db.pedido.findMany({
    where: { status: 'cancelado' },
    select: { id: true, clientName: true, clienteId: true, canceladoAt: true, canceladoMotivo: true, depositUsd: true },
    orderBy: { canceladoAt: 'desc' },
  })
  // Lo retenido es lo acreditado; lo que de verdad quedó en caja es eso menos la brecha.
  const brechas = rows.length > 0 ? await brechaPorPedido(rows.map(r => r.id)) : new Map<number, number>()
  return rows.flatMap(r =>
    r.canceladoAt
      ? [{
          pedidoId: r.id, clientName: r.clientName, clienteId: r.clienteId, fecha: r.canceladoAt,
          motivo: r.canceladoMotivo, retenidoUsd: (dec(r.depositUsd) ?? 0) - (brechas.get(r.id) ?? 0),
        }]
      : [],
  )
}
