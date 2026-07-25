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
