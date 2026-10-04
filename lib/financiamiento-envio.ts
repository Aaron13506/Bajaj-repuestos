// Puro (sin base ni Next) para poder verificarlo en `pnpm check:costeo`.
type Decimalish = { toString(): string }
const num = (d: Decimalish | null | undefined) => (d != null ? parseFloat(d.toString()) : 0)

// Solo un pedido CONFIRMADO cuenta como venta (misma regla que lib/clientes.ts).
const VENTA_STATUS = 'pedido'

export interface PedidoFinanciamientoInput {
  id: number
  tipo: string
  status: string
  depositUsd: Decimalish | null
  items: { salePrice: Decimalish; quantity: number }[]
}

const pedidoTotal = (items: { salePrice: Decimalish; quantity: number }[]) =>
  items.reduce((sum, i) => sum + num(i.salePrice) * i.quantity, 0)

// ─── Quién pone la plata en una caja ─────────────────────────────────────────
// Separa el costo de la caja en tres bolsillos, porque son tres decisiones distintas:
//   · clientes   — pedidos confirmados: es financiar al cliente mientras termina de pagar.
//   · propio     — stock propio: inversión tuya en inventario, no hay a quién cobrarle.
//   · sinAprobar — presupuestos que todavía pueden caerse: riesgo.
// "De tu bolsillo" mezclaba los tres y no dejaba leer cuál era cuál.
//
// El adelanto del cliente se pactó contra su pedido ENTERO, y un pedido puede viajar partido en
// varias cajas. Para el costeo de ESTA caja se prorratea por la parte de la venta que viaja acá:
// contarlo completo en cada caja hacía que dos cajas creyeran que el mismo adelanto las financia.
// Así la suma del adelanto aplicado entre todas las cajas nunca supera lo que el cliente pagó.
export interface LineaFinanciamiento {
  pedidoId: number
  landedUsd: number
  // salePrice × cantidad de la línea (en stock propio es una estimación, no una venta).
  ventaUsd: number
}

export interface FinanciamientoEnvio {
  costoUsd: number
  clientes: { costoUsd: number; ventaUsd: number; adelantoUsd: number; porCobrarUsd: number; pedidos: number }
  propio: { costoUsd: number; ventaEstimadaUsd: number; pedidos: number }
  sinAprobar: { costoUsd: number; ventaUsd: number; pedidos: number }
  /** Adelantos de clientes que cubren esta caja, ya prorrateados. */
  adelantosUsd: number
  /** Lo que sale de tu bolsillo hasta entregar: costo − adelantos. */
  bolsilloUsd: number
  /** Margen SOLO sobre las líneas de cliente: la venta del stock propio todavía no existe. */
  margenClientesUsd: number
  /** Pedidos de cliente con parte de su venta en otra caja. */
  pedidosPartidos: number
}

export function financiamientoEnvio(
  lineas: LineaFinanciamiento[],
  pedidos: PedidoFinanciamientoInput[],
): FinanciamientoEnvio {
  const porPedido = new Map<number, { landed: number; venta: number }>()
  for (const l of lineas) {
    const a = porPedido.get(l.pedidoId) ?? { landed: 0, venta: 0 }
    a.landed += l.landedUsd
    a.venta += l.ventaUsd
    porPedido.set(l.pedidoId, a)
  }

  const out: FinanciamientoEnvio = {
    costoUsd: 0,
    clientes: { costoUsd: 0, ventaUsd: 0, adelantoUsd: 0, porCobrarUsd: 0, pedidos: 0 },
    propio: { costoUsd: 0, ventaEstimadaUsd: 0, pedidos: 0 },
    sinAprobar: { costoUsd: 0, ventaUsd: 0, pedidos: 0 },
    adelantosUsd: 0,
    bolsilloUsd: 0,
    margenClientesUsd: 0,
    pedidosPartidos: 0,
  }

  for (const [pedidoId, a] of porPedido) {
    out.costoUsd += a.landed
    const p = pedidos.find(x => x.id === pedidoId)
    // Una línea cuyo pedido no vino: se trata como riesgo, nunca como venta firme.
    if (!p || (p.tipo !== 'propio' && p.status !== VENTA_STATUS)) {
      out.sinAprobar.costoUsd += a.landed
      out.sinAprobar.ventaUsd += a.venta
      out.sinAprobar.pedidos++
      continue
    }
    if (p.tipo === 'propio') {
      out.propio.costoUsd += a.landed
      out.propio.ventaEstimadaUsd += a.venta
      out.propio.pedidos++
      continue
    }
    const total = pedidoTotal(p.items)
    const recibido = num(p.depositUsd)
    // Parte del pedido que viaja acá; nunca cubre más de lo que se vende acá.
    const adelanto = total > 0 ? Math.min(recibido * (a.venta / total), a.venta) : 0
    out.clientes.costoUsd += a.landed
    out.clientes.ventaUsd += a.venta
    out.clientes.adelantoUsd += adelanto
    out.clientes.pedidos++
    if (a.venta < total - 0.005) out.pedidosPartidos++
  }

  out.adelantosUsd = out.clientes.adelantoUsd
  out.clientes.porCobrarUsd = out.clientes.costoUsd - out.clientes.adelantoUsd
  out.bolsilloUsd = out.costoUsd - out.adelantosUsd
  out.margenClientesUsd = out.clientes.ventaUsd - out.clientes.costoUsd
  return out
}
