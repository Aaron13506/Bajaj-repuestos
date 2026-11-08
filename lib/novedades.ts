import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { eventosGuardados, novedadDeTracking, type Checkpoint } from '@/lib/ship24'

// Novedades del inicio: los trackings cuyo último evento todavía no se vio. La sincronización
// guarda el primer evento en ultimoEventoEn/ultimoEvento, así que la clave sale de esas columnas.
// Es claveEvento (lib/ship24.ts) escrita en SQL: cambiar las dos juntas.
const CLAVE_ULTIMO_EVENTO = Prisma.sql`coalesce(t."ultimoEventoEn", '') || '|' || t."ultimoEvento"`

export type NovedadTracking = {
  id: number
  envioId: number
  caja: string
  express: boolean
  tramo: string
  numero: string
  transportista: string | null
  estado: string | null
  /** Estado del último evento que se vio; null = nunca se vio o ya no está en la lista. */
  antes: string | null
  /** Eventos después del visto; null = nunca se vio (o ya no está en la lista). */
  nuevos: number | null
  ultimo: Checkpoint
  /** La clave que se mostró: «Ya lo vi» marca solo si sigue siendo la última. */
  clave: string
}

export async function trackingsConNovedad(): Promise<NovedadTracking[]> {
  const filas = await db.$queryRaw<{
    id: number; envioId: number; nombre: string | null; modo: string; tramo: string; numero: string
    transportista: string | null; estado: string | null; eventos: unknown; eventoVisto: string | null; clave: string
  }[]>`
    SELECT t.id, t."envioId", e.nombre, e.modo, t.tramo, t.numero, t.transportista, t.estado,
           t.eventos, t."eventoVisto", ${CLAVE_ULTIMO_EVENTO} AS clave
    FROM "EnvioTracking" t JOIN "Envio" e ON e.id = t."envioId"
    WHERE t."ultimoEvento" IS NOT NULL AND t."eventoVisto" IS DISTINCT FROM ${CLAVE_ULTIMO_EVENTO}`
  return filas.flatMap(f => {
    const eventos = eventosGuardados(f.eventos)
    const n = novedadDeTracking(eventos, f.eventoVisto)
    if (!n) return []
    return [{
      id: f.id, envioId: f.envioId, caja: f.nombre ?? `Caja #${f.envioId}`, express: f.modo === 'express',
      tramo: f.tramo, numero: f.numero, transportista: f.transportista, estado: f.estado,
      antes: n.antes, nuevos: n.nuevos, ultimo: eventos[0], clave: f.clave,
    }]
  })
}

/**
 * «Ya lo vi»: guarda como visto el evento que se mostró, solo si sigue siendo el último.
 * Uno que llegó entre que se abrió la página y se tocó el botón no se marca: queda como
 * novedad para la próxima visita. Devuelve cuántos se marcaron.
 */
export async function marcarVistos(vistos: { id: number; clave: string }[]): Promise<number> {
  if (vistos.length === 0) return 0
  return db.$executeRaw`
    UPDATE "EnvioTracking" t SET "eventoVisto" = v.clave
    FROM unnest(${vistos.map(v => v.id)}::int[], ${vistos.map(v => v.clave)}::text[]) AS v(id, clave)
    WHERE t.id = v.id AND ${CLAVE_ULTIMO_EVENTO} = v.clave`
}
