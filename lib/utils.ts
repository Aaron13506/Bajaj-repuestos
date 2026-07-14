import { Prisma } from '@prisma/client'

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
