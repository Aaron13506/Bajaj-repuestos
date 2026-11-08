// Pasar plata de una cuenta a otra: Bs, efectivo, USDT, banco en dólares (puro, sin DB: lo usan el server, el formulario y check:costeo).
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

// Cuánto vale en el libro un bolívar que está en el banco: el COSTO PROMEDIO MÓVIL de lo que
// queda (dólares en la cuenta ÷ Bs en la cuenta), con signo: lo que entra suma, lo que sale
// resta. No hace falta saber qué bolívares se fueron primero: una conversión saca Bs a este
// mismo valor, así que el promedio de lo que queda no se mueve por ella.
//
// Antes era el promedio de TODO lo cobrado en la historia. Con el bolívar devaluándose cada mes,
// los Bs de enero (ya convertidos) seguían pesando en octubre: 40.000 Bs = $1000 en enero y
// 200.000 Bs = $1000 en octubre daban un valor de $1667 a los 200.000 de hoy, y convertirlos
// por 990 USDT anotaba $677 de "costo" en vez de $10.
//
// Solo cuentan las filas con Bs anotados (las de antes de guardarlos no dicen cuántos fueron).
// Null = no queda nada en la cuenta según lo anotado: no hay de dónde sacar un valor.
export function usdPorBsEnCuenta(movs: { usd: number; bs: number }[]): number | null {
  let usd = 0
  let bs = 0
  for (const m of movs) {
    if (m.bs !== 0) { usd += m.usd; bs += m.bs }
  }
  return bs > 0.005 && usd > 0.005 ? usd / bs : null
}

// El valor por Bs con el que salen `bsDados` del banco. Si se dan todos los Bs anotados (o más),
// sale todo lo que el libro tiene en dólares: con el promedio, dar unos Bs de más dejaba la
// cuenta en centavos negativos con 0 Bs, y ese residuo no se iba nunca.
export function usdPorBsAlConvertir(bsDados: number, movs: { usd: number; bs: number }[]): number | null {
  const promedio = usdPorBsEnCuenta(movs)
  if (promedio == null) return null
  const conBs = movs.filter(m => m.bs !== 0)
  const bs = conBs.reduce((s, m) => s + m.bs, 0)
  const usd = conBs.reduce((s, m) => s + m.usd, 0)
  return bsDados >= bs - 0.005 ? usd / bsDados : promedio
}

export interface Conversion {
  /** Lo que el libro dice que valía lo entregado, en dólares reales (la pata que sale). */
  valorLibroUsd: number
  /** Lo que entra al libro por lo recibido (la pata que entra). */
  entradaUsd: number
  /** valorLibro − entrada: positivo es costo, negativo es ganancia por conversión. */
  costoUsd: number
  /** Unidades dadas por unidad recibida (Bs por USDT si se dieron Bs). */
  tasaEfectiva: number
  /** El costo como % del valor en libro. */
  costoPct: number
}

// `usdPorDado`: cuánto vale en el libro una unidad de lo dado (1 si son dólares, el promedio de la
// cuenta si son Bs). Si lo recibido son Bs, entran por lo que valía lo que se dio: el libro no
// tiene con qué más valorarlos (una tasa de mercado sería inventar), así que esa pata no cuesta
// nada y su costo real aparece cuando esos Bs se conviertan o se gasten.
export function convertir(dado: number, recibido: number, usdPorDado: number, recibeBs = false): Conversion {
  const valorLibroUsd = round2(dado * usdPorDado)
  const entradaUsd = recibeBs ? valorLibroUsd : round2(recibido)
  const costoUsd = round2(valorLibroUsd - entradaUsd)
  return {
    valorLibroUsd,
    entradaUsd,
    costoUsd,
    tasaEfectiva: dado / recibido,
    costoPct: valorLibroUsd > 0 ? (costoUsd / valorLibroUsd) * 100 : 0,
  }
}
