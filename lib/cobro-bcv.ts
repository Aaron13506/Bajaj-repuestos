// Cobro a "dólar BCV" (puro, sin DB: lo usan el server, los formularios y check:costeo).
//
// Todo lo guardado está en dólares REALES: PedidoItem.salePrice, Pedido.depositUsd y
// Movimiento.monto. Es la unidad de la caja, de los costos y del margen, y no se mezcla.
// El dólar BCV es solo cómo se le PRESENTA y se le COBRA al cliente: el real dividido entre
// (1 − escalón de brecha), ver calcPrecioBcv. Quien paga en divisas paga el real (ese es
// el "descuento por pago en divisas"); quien paga en Bs paga el monto BCV a la tasa BCV del
// día, y eso vale en reales el monto BCV × (1 − escalón).
//
// Un presupuesto usa el escalón de HOY. Un pedido confirmado usa el que se congeló al
// confirmarlo (Pedido.brechaEscalonPct): el cliente aceptó un total en dólares BCV y ese
// total no puede moverse porque la brecha se movió después. Null = pedido en dólares
// reales (los anteriores al cobro a BCV y el stock propio).

const round2 = (n: number) => Math.round(n * 100) / 100

// Precio real → precio BCV. Parte del precio en centavos y redondea al más cercano: así
// round2(bcv × (1 − escalón)) vuelve EXACTO al real (check:costeo lo verifica).
export function aDolarBcv(usdReal: number, escalonPct: number): number {
  return round2(round2(usdReal) / (1 - escalonPct / 100))
}

export interface ResumenCobro {
  /** null = pedido en dólares reales: los montos "Bcv" son iguales a los reales. */
  escalonPct: number | null
  totalReal: number
  /** Suma de subtotales BCV línea por línea: lo que dice la tabla, al centavo. */
  totalBcv: number
  /** Dólares reales por dólar BCV en ESTE pedido: totalReal / totalBcv (≈ 1 − escalón). */
  factor: number
  depositoReal: number
  /** Lo cobrado, expresado en dólares BCV (totalBcv − saldoBcv). */
  abonadoBcv: number
  saldoBcv: number
  /** El mismo saldo pagado en divisas. */
  saldoReal: number
}

// Entre real y BCV se convierte con la proporción del propio pedido y no con (1 − escalón)
// pelado: el total BCV suma líneas ya redondeadas al centavo y en un pedido grande se aleja
// unos centavos de totalReal / (1 − escalón). Con el factor del pedido, sin cobrar el saldo
// BCV es exactamente el total de la tabla y pagado todo es exactamente cero (los dos extremos
// que el cliente ve); con (1 − escalón) un pedido pagado completo quedaba en −$0.05.
export function resumenCobro(
  lineas: { salePrice: number; quantity: number }[],
  depositoReal: number,
  escalonPct: number | null,
): ResumenCobro {
  const totalReal = round2(lineas.reduce((s, l) => s + l.salePrice * l.quantity, 0))
  const totalBcv =
    escalonPct == null ? totalReal : round2(lineas.reduce((s, l) => s + aDolarBcv(l.salePrice, escalonPct) * l.quantity, 0))
  const factor = escalonPct == null ? 1 : totalBcv > 0 ? totalReal / totalBcv : 1 - escalonPct / 100
  const saldoReal = round2(totalReal - depositoReal)
  const saldoBcv = round2(saldoReal / factor)
  return { escalonPct, totalReal, totalBcv, factor, depositoReal, abonadoBcv: round2(totalBcv - saldoBcv), saldoBcv, saldoReal }
}

// Monto que se escribe en un formulario de cobro → dólares reales a guardar.
// En Bs se escribe el monto BCV (lo que el cliente pagó en Bs ÷ la tasa BCV de ese día); en
// divisas, los dólares que entraron. Si lo escrito en BCV es lo que se debía cubrir (el
// saldo, o el total en el caso del adelanto), se guarda el real exacto de eso: así pagar
// "todo" deja el saldo en cero y no en un centavo suelto del redondeo.
export function realDeCobro(
  monto: number,
  enBolivares: boolean,
  pedido: ResumenCobro,
  cubre?: { bcv: number; real: number },
): number {
  if (pedido.escalonPct == null || !enBolivares) return round2(monto)
  if (cubre && Math.abs(monto - cubre.bcv) <= 0.01) return cubre.real
  return round2(monto * pedido.factor)
}

// Nota para el libro: el Movimiento queda en reales, y esto deja a la vista lo que se cobró.
export function notaCobroBcv(monto: number, enBolivares: boolean, escalonPct: number | null): string | null {
  if (escalonPct == null || !enBolivares) return null
  return `Cobrado $${monto.toFixed(2)} a tasa BCV (escalón ${escalonPct}%)`
}
