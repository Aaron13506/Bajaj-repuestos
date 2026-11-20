import { Prisma } from '@prisma/client'

// Los dos rechazos de la base que una pantalla provoca sin que haya un bug: P2002 es "ya
// existe" (un nombre único, un doble envío) y P2003 es "lo que elegiste ya no está" (una
// pestaña vieja apunta a un pedido, un envío o un proveedor que se borró). Las acciones los
// traducen a un mensaje; cualquier otro error sigue siendo ruidoso.
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export function isForeignKeyViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003'
}

// La base se negó a dejar una pieza con stock negativo (CHECK Product_stock_no_negativo, código
// Postgres 23514). Con `$executeRaw` llega como P2010 con el nombre de la restricción en el
// mensaje; lib/stock.ts lo traduce a "No alcanza el stock de X".
export function esStockNegativo(e: unknown): boolean {
  return /Product_stock_no_negativo/.test(e instanceof Error ? e.message : String(e))
}
