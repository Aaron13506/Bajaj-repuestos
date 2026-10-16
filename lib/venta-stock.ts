// Vender del depósito (puro, sin DB: lo usan el server, el formulario y check:costeo).
//
// Todo lo que se arma para stock propio terminaba en un callejón sin salida: entraba a
// `Product.stock` y no había forma de sacarlo vendiéndolo. Anotar un `otro_ingreso` y bajar el
// stock a mano dejaba la venta sin costo, sin margen y con el inventario valuado de más.
//
// Una venta directa es un Pedido de tipo 'venta' que nace confirmado y entregado: no hay
// presupuesto que aprobar, ni compra, ni caja. Cada línea es una pieza suelta del depósito (un
// conjunto no tiene stock propio: lo que se guarda son sus piezas) y congela lo que costó, para
// que el margen real de esa venta se pueda leer después sin reconstruirlo. El costo se guarda
// en `PedidoItem.costRealUsd`, que ya significa "lo que costó esta línea": una línea que llegó
// del depósito no tiene compra pendiente, y así ninguna lista de "falta cargar el costo" la
// confunde con una.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface LineaVenta {
  productId: number
  quantity: number
  /** Precio de venta por unidad, en dólares reales. */
  salePrice: number
  /** Lo que costó cada unidad que se saca del depósito. */
  costoUnitUsd: number
}

export interface PiezaEnDeposito {
  id: number
  stock: number
  nameEs: string
  bajajCode: string | null
}

const nombre = (p: PiezaEnDeposito) => p.bajajCode ?? p.nameEs

// Lo que impide hacer esta venta, o null si se puede. Es el chequeo de pantalla; el definitivo
// es el UPDATE con condición sobre el stock, que es el que aguanta dos ventas a la vez.
export function motivoNoVendible(lineas: LineaVenta[], piezas: PiezaEnDeposito[]): string | null {
  if (lineas.length === 0) return 'Agregá al menos una pieza.'
  const porId = new Map(piezas.map(p => [p.id, p]))
  const vistos = new Set<number>()
  for (const l of lineas) {
    const p = porId.get(l.productId)
    if (!p) return `La pieza ${l.productId} ya no existe.`
    if (vistos.has(l.productId)) return `${nombre(p)} aparece dos veces: sumá las cantidades en una sola línea.`
    vistos.add(l.productId)
    if (!Number.isInteger(l.quantity) || l.quantity < 1) return `${nombre(p)}: la cantidad tiene que ser un entero de 1 o más.`
    if (!Number.isFinite(l.salePrice) || l.salePrice < 0) return `${nombre(p)}: el precio de venta no es un número válido.`
    // Sin costo no hay margen, y vacío no es cero: un costo en 0 pasaría por ganancia pura.
    if (!Number.isFinite(l.costoUnitUsd) || l.costoUnitUsd <= 0) {
      return `${nombre(p)}: cargá cuánto costó. Sin costo no se puede saber cuánto se ganó.`
    }
    if (p.stock < l.quantity) {
      return `${nombre(p)}: hay ${p.stock} en el depósito y se piden ${l.quantity}.`
    }
  }
  return null
}

// Lo que costó la línea entera: es lo que va a `costRealUsd`.
export function costoDeLinea(costoUnitUsd: number, quantity: number): number {
  return round2(costoUnitUsd * quantity)
}

export interface ResumenVenta {
  ventaUsd: number
  costoUsd: number
  margenUsd: number
  /** Ganancia sobre el precio de venta (la misma definición de margen que el catálogo). */
  margenPct: number
}

export function resumenVenta(lineas: LineaVenta[]): ResumenVenta {
  const ventaUsd = round2(lineas.reduce((s, l) => s + l.salePrice * l.quantity, 0))
  const costoUsd = round2(lineas.reduce((s, l) => s + costoDeLinea(l.costoUnitUsd, l.quantity), 0))
  const margenUsd = round2(ventaUsd - costoUsd)
  return { ventaUsd, costoUsd, margenUsd, margenPct: ventaUsd > 0 ? (margenUsd / ventaUsd) * 100 : 0 }
}

// ── Servir una línea de un pedido de cliente con lo del depósito ─────────────────────────────
//
// Un pedido por encargo con una pieza que YA está en el depósito la mandaba igual a comprar y a
// viajar en una caja. Servirla desde el stock la saca del depósito al momento (se le reserva al
// cliente), congela su costo como una venta del depósito (lo que vale en el inventario) y la deja
// "en Venezuela", lista para entregar desde la ficha del pedido. No pasa por compra ni por caja.
// shortcut: solo piezas sueltas; un conjunto serviría pieza por pieza y eso pide su propio flujo.

export interface LineaServible {
  productId: number | null
  ensambleId: number | null
  quantity: number
  envioId: number | null
  shippingStatus: string
  costRealUsd: number | null
  desdeStock: boolean
}

// Lo que impide servirla, o null si se puede. El stock es el chequeo de pantalla; el definitivo es
// el UPDATE con condición sobre el stock.
export function motivoNoServible(
  l: LineaServible,
  pedido: { tipo: string; status: string },
  pieza: { stock: number; costoUnitUsd: number | null } | null,
): string | null {
  if (pedido.tipo !== 'cliente' || pedido.status !== 'pedido') return 'Solo se sirve una línea de un pedido de cliente confirmado.'
  if (l.desdeStock) return 'Esta línea ya se sirvió con lo del depósito.'
  if (l.productId == null || l.ensambleId != null || !pieza) return 'Solo una pieza suelta se sirve con lo del depósito; un conjunto se compra.'
  if (l.costRealUsd != null || l.shippingStatus !== 'pendiente') return 'Esta línea ya se compró: no se sirve con lo del depósito.'
  if (l.envioId != null) return 'Esta línea está en una caja: sacala de la caja antes de servirla con lo del depósito.'
  if (pieza.stock < l.quantity) return `Hay ${pieza.stock} en el depósito y la línea lleva ${l.quantity}.`
  // Sin costo no hay margen, y vacío no es cero (igual que en una venta del depósito).
  if (pieza.costoUnitUsd == null || !(pieza.costoUnitUsd > 0)) return 'La pieza no tiene costo cargado: sin costo no se sabría cuánto se ganó.'
  return null
}
