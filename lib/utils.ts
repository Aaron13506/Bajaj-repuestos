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
