/**
 * De qué ensamble salió cada pieza, cuando la línea no lo guarda.
 *
 * `EnvioLinea` es producto y cantidad, nada más, pero la caja se arma recorriendo
 * despieces. Una pieza cuelga de varios ensambles (un tornillo está en veinte), así que hay
 * que elegirle uno: gana el que cubre más piezas TODAVÍA sin asignar. Eso reconstruye cómo
 * se armó la caja —ensamble por ensamble— y deja cada pieza en un solo grupo.
 *
 * `grupos` va de la clave del ensamble (su id, o su nombre si se agrupan variantes) a las
 * piezas que contiene; `comparar` desempata entre dos que cubren lo mismo, para que el
 * resultado no cambie de una carga a otra. `orden` son los ensambles en el orden en que
 * se eligieron; las piezas que no quedan en `asignado` no cuelgan de ninguno.
 */
export function asignarPorCobertura<K>(
  grupos: Map<K, Set<number>>,
  piezas: Iterable<number>,
  comparar: (a: K, b: K) => number,
): { asignado: Map<number, K>; orden: K[] } {
  const pendientes = new Set(piezas)
  const asignado = new Map<number, K>()
  const orden: K[] = []
  for (;;) {
    let mejor: { clave: K; n: number } | null = null
    for (const [clave, hijos] of grupos) {
      let n = 0
      for (const hijo of hijos) if (pendientes.has(hijo)) n++
      if (n > 0 && (mejor == null || n > mejor.n || (n === mejor.n && comparar(clave, mejor.clave) < 0))) {
        mejor = { clave, n }
      }
    }
    if (mejor == null) break
    for (const hijo of grupos.get(mejor.clave)!) {
      if (pendientes.delete(hijo)) asignado.set(hijo, mejor.clave)
    }
    orden.push(mejor.clave)
  }
  return { asignado, orden }
}
