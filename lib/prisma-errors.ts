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
