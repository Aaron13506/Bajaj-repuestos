import { Prisma } from '@prisma/client'

// Builds a safe file name from arbitrary parts (e.g. client name, doc label),
// stripping characters that are invalid in Windows/macOS/Linux file systems.
export function toFileName(parts: (string | number)[], ext: string): string {
  const base = parts
    .map(p => String(p).trim())
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]/g, '')
  return `${base}.${ext}`
}

// Algunos nombres del scraper quedaron con la entidad HTML sin decodificar
// ("Logos &amp; Decals"). Los de la base ya se limpiaron, pero los snapshots de piezas
// guardados en PedidoItem.bundleItems son inmutables por diseño, así que se limpia al
// mostrar para no arrastrar el error a la UI ni a los PDF.
export function limpiarNombre(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

// Orden alfabético de piezas — el mismo criterio en el builder (cliente), en la vista
// del presupuesto y en el PDF, para que la lista no cambie de orden entre pantallas.
// Se compara en JS y no en el `ORDER BY` de Postgres justamente por eso: la collation
// de la base no coincide con la del navegador en acentos ni en mayúsculas.
export function compararNombre(a: string, b: string): number {
  return a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true })
}

// Serializa para la API convirtiendo los Decimal de Prisma a número.
//
// La versión anterior chequeaba `value instanceof Prisma.Decimal` DENTRO del replacer de
// JSON.stringify, y esa rama no se ejecutó nunca: Decimal define su propio `toJSON`, y el
// orden del estándar es toJSON primero y el replacer después (ES2015 §SerializeJSONProperty).
// Para cuando el replacer miraba el valor, ya era el string "12.34" y el instanceof daba
// false. Resultado: la API prometía números y entregaba strings, así que cualquier
// consumidor que sumara `price` concatenaba.
//
// Se resuelve del lado del HOLDER, que es el único lugar donde el Decimal todavía es un
// Decimal: se recorre la estructura antes de serializar. De paso desaparece el
// JSON.parse(JSON.stringify(...)), que recorría todo dos veces.
function decimalesANumero(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toNumber()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(decimalesANumero)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = decimalesANumero(v)
    return out
  }
  return value
}

export function toJSON<T>(data: T): T {
  return decimalesANumero(data) as T
}

/**
 * La fecha de hoy como `YYYY-MM-DD` en la zona horaria de QUIEN la mira. `toISOString()` es
 * UTC: en Venezuela (UTC-4), desde las 20:00 devuelve el día de mañana, y un movimiento que
 * se dejaba con esa fecha caía en otro mes en los reportes de fin de mes. El locale `en-CA`
 * es el que imprime año-mes-día.
 *
 * Solo tiene sentido en el navegador: en el server (Heroku, UTC) devolvería la fecha de
 * allá. Para el valor inicial de un campo de fecha usar `CampoFecha`.
 */
export const hoyLocal = () => new Date().toLocaleDateString('en-CA')

// "hace 12 min" / "hace 3 h" / "hace 2 d" — para saber si una tasa que actualiza un cron
// (BCV, BsD, INR) es la del día o quedó vieja porque el cron se cayó. Redondea hacia abajo:
// "hace 0 min" avisa que acaba de correr, no hace falta un caso especial para eso.
export function haceTiempo(d: Date): string {
  const segundos = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (segundos < 60) return 'hace instantes'
  const minutos = Math.floor(segundos / 60)
  if (minutos < 60) return `hace ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${horas} h`
  const dias = Math.floor(horas / 24)
  return `hace ${dias} d`
}
