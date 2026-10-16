// Pasar bolívares a USDT (puro, sin DB: lo usan el server, el formulario y check:costeo).
//
// Los Bs entraron al libro como dólares reales (`monto`) a la tasa de cada cobro. Cuando se
// convierten, salen del banco por lo que el libro dice que valen y entran a USDT por lo que
// llegó: la diferencia es lo que costó convertir (spread de la casa de cambio, más lo que la
// tasa se movió desde que se cobró), y es un costo real de cada pedido que antes no figuraba.
//
// Se anota como DOS movimientos (conversion_salida del banco, conversion_entrada a USDT) y el
// costo no es un tercero: es la resta. Así la caja baja exactamente ese costo, sin inventar un
// gasto aparte que habría que mantener de acuerdo con las dos patas.

const round2 = (n: number) => Math.round(n * 100) / 100

// Cuánto vale en el libro un bolívar que está en el banco: el promedio ponderado de lo que
// entró (dólares reales ÷ Bs), no de lo que queda — no se sabe qué bolívares se fueron
// primero, y un promedio de lo cobrado es lo más cercano que da el dato sin llevar lotes.
// Null = todavía no hay ningún cobro en Bs con su monto anotado.
export function usdPorBsPromedio(ingresos: { usd: number; bs: number }[]): number | null {
  let usd = 0
  let bs = 0
  for (const i of ingresos) {
    if (i.bs > 0) { usd += i.usd; bs += i.bs }
  }
  return bs > 0 ? usd / bs : null
}

export interface Conversion {
  /** Lo que el libro dice que valían los Bs que salieron del banco, en dólares reales. */
  valorLibroUsd: number
  /** Lo que llegó a USDT. */
  usdt: number
  /** valorLibro − usdt: positivo es costo, negativo es ganancia por conversión. */
  costoUsd: number
  /** Bs por USDT a los que se hizo, la tasa efectiva. */
  tasaEfectiva: number
  /** El costo como % del valor en libro. */
  costoPct: number
}

export function convertir(bs: number, usdt: number, usdPorBs: number): Conversion {
  const valorLibroUsd = round2(bs * usdPorBs)
  const costoUsd = round2(valorLibroUsd - usdt)
  return {
    valorLibroUsd,
    usdt: round2(usdt),
    costoUsd,
    tasaEfectiva: bs / usdt,
    costoPct: valorLibroUsd > 0 ? (costoUsd / valorLibroUsd) * 100 : 0,
  }
}
