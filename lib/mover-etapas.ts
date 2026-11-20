import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import { statusIndex } from '@/lib/shipping-status'
import { avanzaSinEstar } from '@/lib/sin-stock'
import { conStockSuficiente, sqlStockDesde, StockInsuficiente } from '@/lib/stock'
import { randomUUID } from 'node:crypto'

// El SQL que mueve líneas de etapa (saveItemChanges en envios/actions.ts): fuera de la acción para
// que `scripts/check-etapas-sql.ts` lo pruebe contra la base local sin el runtime de Next.

export interface FilaEtapa {
  id: number
  /** La etapa que se LEYÓ: la fila solo se mueve si sigue ahí (doble click = no-op). */
  desde: string
  hacia: string
  /** +1 suma al stock (llega a 'entregado'), −1 resta (sale de 'entregado'), 0 no lo toca. */
  signo: number
}

export interface PiezaEtapa {
  itemId: number
  productId: number
  unidades: number
}

// El UPDATE guardado por la etapa leída y su fila de historial, sobre `v(id, desde, hacia, signo)`.
function sqlMover(envioId: number) {
  // La fecha de compra se sella la primera vez que el ítem deja de estar pendiente, y se borra si
  // vuelve a pendiente. La hora se toma en la base, en UTC (así guarda Prisma los DateTime).
  const mover = Prisma.sql`
    UPDATE "PedidoItem" AS pi
    SET "shippingStatus" = v.hacia,
        "shippingStatusAt" = (NOW() AT TIME ZONE 'UTC'),
        "compradoAt" = CASE
          WHEN v.hacia = 'pendiente' THEN NULL
          WHEN v.desde = 'pendiente' THEN (NOW() AT TIME ZONE 'UTC')
          ELSE pi."compradoAt"
        END
    FROM v
    WHERE pi."id" = v.id AND pi."envioId" = ${envioId} AND pi."shippingStatus" = v.desde
    RETURNING pi."id", pi."pedidoId", v.signo, v.desde, v.hacia`
  // Cada fila que de verdad se movió deja su paso en el historial (misma sentencia: no hay un
  // cambio de etapa sin su registro ni un registro de uno que otra request ya hizo).
  const etapa = Prisma.sql`
    INSERT INTO "PedidoItemEtapa" ("itemId", "desde", "hacia", "at")
    SELECT m."id", m.desde, m.hacia, (NOW() AT TIME ZONE 'UTC') FROM movidas m`
  return { mover, etapa }
}

const valoresDe = (filas: FilaEtapa[]) =>
  Prisma.join(filas.map(f => Prisma.sql`(${f.id}::int, ${f.desde}::text, ${f.hacia}::text, ${f.signo}::int)`))

// Mueve de etapa sin tocar el stock, dentro de la transacción de quien llama, y devuelve cuántas
// filas se movieron de verdad. Lo usan el cierre y la reversa de una recepción (lib/recepcion-db),
// que escriben el stock aparte con moverStock.
export async function moverEtapasEn(tx: Prisma.TransactionClient, envioId: number, filas: FilaEtapa[]): Promise<number> {
  if (filas.length === 0) return 0
  const { mover, etapa } = sqlMover(envioId)
  const r = await tx.$queryRaw<{ n: number }[]>`
    WITH v(id, desde, hacia, signo) AS (VALUES ${valoresDe(filas)}), movidas AS (${mover}), etapas AS (${etapa})
    SELECT COUNT(*)::int AS n FROM movidas`
  return r[0].n
}

// Tira ErrorDeNegocio (y no cambia nada) si sacar de 'entregado' dejaría un stock negativo.
export async function moverEtapas(envioId: number, filas: FilaEtapa[], piezas: PiezaEtapa[]): Promise<void> {
  // UNA sentencia: el cambio de estado y el ajuste de stock salen de las mismas filas (las
  // que de verdad se movieron, RETURNING), así que no puede haber una sin la otra ni un stock
  // sumado por una fila que otra request ya movió.
  const valores = valoresDe(filas)
  const { mover, etapa } = sqlMover(envioId)

  if (piezas.length === 0) {
    await db.$executeRaw`WITH v(id, desde, hacia, signo) AS (VALUES ${valores}), movidas AS (${mover}) ${etapa}`
    return
  }

  const valoresPiezas = Prisma.join(
    piezas.map(p => Prisma.sql`(${p.itemId}::int, ${p.productId}::int, ${p.unidades}::int)`),
  )
  // Cada fila que de verdad se movió deja en el kardex (lib/stock.ts) lo que sumó o restó de
  // cada pieza: así una fila que otra request ya movió tampoco deja movimiento.
  const kardex = sqlStockDesde(Prisma.sql`
    SELECT pz.product_id, m.signo * pz.unidades,
           CASE WHEN m.signo > 0 THEN 'entrega_propio' ELSE 'reversa_entrega_propio' END,
           NULL::numeric, NULL::text, ${envioId}::int, m."pedidoId", m."id", NULL::int, ${randomUUID()}::text
    FROM movidas m JOIN piezas pz ON pz.item_id = m."id"
    WHERE m.signo <> 0 AND pz.unidades <> 0`)
  const signoDe = new Map(filas.map(f => [f.id, f.signo]))
  const deltas = new Map<number, number>()
  for (const p of piezas) deltas.set(p.productId, (deltas.get(p.productId) ?? 0) + (signoDe.get(p.itemId) ?? 0) * p.unidades)
  // Sacar de 'entregado' resta del depósito: si eso ya se vendió, la base rechaza el stock
  // negativo (afirmaría que se vendió lo que no existía) y no cambia nada.
  try {
    await conStockSuficiente(deltas, () => db.$executeRaw`
      WITH v(id, desde, hacia, signo) AS (VALUES ${valores}),
      piezas(item_id, product_id, unidades) AS (VALUES ${valoresPiezas}),
      movidas AS (${mover}),
      etapas AS (${etapa}),
      ${kardex}`)
  } catch (e) {
    if (!(e instanceof StockInsuficiente)) throw e
    throw new ErrorDeNegocio(
      `No se puede sacar de entregado: ya no hay en stock lo que esta línea sumó ` +
      `(${e.piezas.slice(0, 3).join(', ')}). Se vendió o se ajustó a mano; corregí ese stock primero.`,
    )
  }
}

// Una línea que el proveedor no mandó entera nunca estuvo en el depósito: si figura más adelante
// (se avanzó la caja antes de anotar el aviso), vuelve a «camino al depósito», que es donde está
// de verdad, y desde ahí se puede sacar o pasar a otra caja. Guardado por la etapa leída.
export async function noVinoVuelveACamino(tx: Prisma.TransactionClient, itemId: number, desde: string): Promise<void> {
  if (!avanzaSinEstar(desde) || statusIndex(desde) >= statusIndex('en_venezuela')) return
  const r = await tx.pedidoItem.updateMany({ where: { id: itemId, shippingStatus: desde }, data: { shippingStatus: 'camino_shoppre', shippingStatusAt: new Date() } })
  if (r.count) await tx.pedidoItemEtapa.create({ data: { itemId, desde, hacia: 'camino_shoppre' } })
}
