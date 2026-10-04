// Reparte lo que se pagó por una compra entre las líneas que cubrió.
//
// Es un prorrateo en proporción a `pesos` (el estimado del catálogo de cada línea), no un
// precio exacto: el único número real es el total pagado, y por eso el reparto tiene que
// SUMAR EXACTAMENTE ese total. Redondear cada parte a centavos por separado no lo garantiza
// (tres partes iguales de $10.00 dan 3.33 + 3.33 + 3.33 = 9.99), y esa diferencia es plata
// que queda en el libro sin ninguna línea que la explique.
//
// Método del mayor resto, en centavos enteros: cada parte toma el piso de su cuota exacta y
// los centavos que sobran van de a uno a las partes con mayor fracción descartada. Nunca
// genera una parte negativa (un residuo asignado a una sola línea sí podía), y el resultado
// no depende del orden salvo en empates exactos.
//
// Sin pesos (todos 0, ningún SKU con precio ni estimado) reparte por partes iguales en vez
// de dividir por cero.
export function repartirEnCentavos(monto: number, pesos: number[]): number[] {
  const n = pesos.length
  if (n === 0) return []

  const totalCent = Math.round(monto * 100)
  const w = pesos.map(p => (Number.isFinite(p) && p > 0 ? p : 0))
  const suma = w.reduce((s, x) => s + x, 0)

  const exacto = w.map(x => (suma > 0 ? (totalCent * x) / suma : totalCent / n))
  const cent = exacto.map(Math.floor)

  let resto = totalCent - cent.reduce((s, c) => s + c, 0)
  const orden = exacto
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; resto > 0 && k < orden.length; k++, resto--) cent[orden[k].i]++

  return cent.map(c => c / 100)
}
