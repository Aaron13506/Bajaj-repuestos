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

export function toJSON<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (_, value) => {
      if (value instanceof Prisma.Decimal) {
        return parseFloat(value.toString())
      }
      return value
    }),
  )
}
