// ─────────────────────────────────────────────────────────────────────────────
// Lectura de Config, del lado puro.
//
// Este módulo NO importa la base a propósito. `lib/calc.ts` lo usa, y a calc lo
// importan módulos que corren en el navegador (comparar-compra, que recalcula en cada
// tecla). Si acá entrara `lib/db`, Prisma entero se arrastraría al bundle del cliente.
// Es la misma razón por la que existe lib/json-ia.ts. El viaje a la base vive aparte,
// en lib/config-db.ts.
//
// ── Por qué `num()` y no `parseFloat(cfg.x ?? '95')` ────────────────────────────
// El `??` cubre la key AUSENTE, que es el caso fácil. El que pasa de verdad es la key
// PRESENTE Y ROTA: estas keys las escribe el cron horario y se editan a mano en
// /config, así que un campo guardado en blanco o con un espacio de más da NaN. Y el
// NaN no explota: se propaga callado por productCostUsd → landedCostUsd → priceUsd
// hasta la pantalla, que es el peor final posible para un número que fija precios de
// venta. `num()` es el único acceso numérico a Config por eso.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfigMap = Record<string, string>

/** Las filas de Config como mapa. Era un `reduce` copiado en 17 archivos. */
export function toConfigMap(rows: { key: string; value: string }[]): ConfigMap {
  const cfg: ConfigMap = {}
  for (const r of rows) cfg[r.key] = r.value
  return cfg
}

/**
 * Lee una key numérica de Config. Cae a `fallback` si falta, si está vacía o si no es
 * un número finito — nunca devuelve NaN ni Infinity.
 */
export function num(cfg: ConfigMap, key: string, fallback: number): number {
  const v = parseFloat(cfg[key] ?? '')
  return Number.isFinite(v) ? v : fallback
}

/**
 * Margen global, como fracción (0.40), desde `default_margin_pct`, que Config guarda
 * en PORCENTAJE (40).
 *
 * Existe porque la conversión estaba escrita a mano en siete lugares y uno de ellos
 * —`applyMargin` en lib/calc.ts— leía una key que no existe (`default_margin`, sin el
 * `_pct`), así que su fallback global no se activó nunca. El bug era invisible: la
 * pieza sin margen propio salía sin precio y parecía que le faltaba un dato.
 */
export function margenPorDefecto(cfg: ConfigMap): number {
  return num(cfg, 'default_margin_pct', 40) / 100
}

/**
 * Lee una key booleana de Config. Es el `num()` de los sí/no, y por la misma razón: el
 * valor lo escribe un formulario pero también se edita a mano, así que "TRUE", "1", "no"
 * o un campo en blanco tienen que caer del lado correcto en vez de decidirse por una
 * comparación literal contra la palabra exacta.
 *
 * Esto era `cfg.shoppre_member !== 'false'` repetido en calc y en el comparador — una
 * cuenta con una sola forma de apagarse: cualquier otra cosa que "false" (incluido
 * "FALSE", "0" o "no") dejaba la tarifa de socio prendida, que es un 5% de descuento
 * que Shoppre no da y que termina metido en un precio de venta.
 */
export function flag(cfg: ConfigMap, key: string, fallback: boolean): boolean {
  const v = (cfg[key] ?? '').trim().toLowerCase()
  if (v === '') return fallback
  if (['true', '1', 'si', 'sí', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return fallback
}
