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
  const perdidasRows = pedidos.length > 0
    ? await db.incidencia.groupBy({
        by: ['pedidoId'],
        where: { pedidoId: { in: pedidos.map(p => p.id) }, resolucion: 'reembolso', perdidaUsd: { not: null } },
        _sum: { perdidaUsd: true },
        _max: { resueltaAt: true },
      })
    : []
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
    // La caja está cerrada en números cuando cada carrier facturó su tramo: el facturado pisa al
    // de tabla, así que el peso de la caja ya no cambia el total, solo el prorrateo entre líneas
    // (tan prorrateo como el de la compra). Una pieza sin peso sí: se queda sin su parte del flete.
    const flete = calc.tramo ? calc.tramo.faltaCosto !== true : e.shippingCostRealAereo != null
    const cajaReal = flete && e.shippingCostRealMaritimo != null && !calc.lines.some(l => l.missingWeight)
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
    const margen = margenDePedido(lineas, perdidasDe.get(p.id))
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
  return rows.flatMap(r =>
    r.canceladoAt
      ? [{
          pedidoId: r.id, clientName: r.clientName, clienteId: r.clienteId, fecha: r.canceladoAt,
          motivo: r.canceladoMotivo, retenidoUsd: dec(r.depositUsd) ?? 0,
        }]
      : [],
  )
}
