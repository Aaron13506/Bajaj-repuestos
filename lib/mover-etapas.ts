import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'

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

// Tira ErrorDeNegocio (y no cambia nada) si sacar de 'entregado' dejaría un stock negativo.
export async function moverEtapas(envioId: number, filas: FilaEtapa[], piezas: PiezaEtapa[]): Promise<void> {
  // UNA sentencia: el cambio de estado y el ajuste de stock salen de las mismas filas (las
  // que de verdad se movieron, RETURNING), así que no puede haber una sin la otra ni un stock
  // sumado por una fila que otra request ya movió. La fecha de compra se sella la primera vez
  // que el ítem deja de estar pendiente, y se borra si vuelve a pendiente. La hora se toma en
  // la base, en UTC (así guarda Prisma los DateTime).
  const valores = Prisma.join(
    filas.map(f => Prisma.sql`(${f.id}::int, ${f.desde}::text, ${f.hacia}::text, ${f.signo}::int)`),
  )
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
    RETURNING pi."id", v.signo, v.desde, v.hacia`
  // Cada fila que de verdad se movió deja su paso en el historial (misma sentencia: no hay un
  // cambio de etapa sin su registro ni un registro de uno que otra request ya hizo).
  const etapa = Prisma.sql`
    INSERT INTO "PedidoItemEtapa" ("itemId", "desde", "hacia", "at")
    SELECT m."id", m.desde, m.hacia, (NOW() AT TIME ZONE 'UTC') FROM movidas m`

  if (piezas.length === 0) {
    await db.$executeRaw`WITH v(id, desde, hacia, signo) AS (VALUES ${valores}), movidas AS (${mover}) ${etapa}`
    return
  }

  const valoresPiezas = Prisma.join(
    piezas.map(p => Prisma.sql`(${p.itemId}::int, ${p.productId}::int, ${p.unidades}::int)`),
  )
  await db.$transaction(async tx => {
    await tx.$executeRaw`
      WITH v(id, desde, hacia, signo) AS (VALUES ${valores}),
      piezas(item_id, product_id, unidades) AS (VALUES ${valoresPiezas}),
      movidas AS (${mover}),
      etapas AS (${etapa})
      UPDATE "Product" AS p
      SET "stock" = p."stock" + s.delta, "updatedAt" = NOW()
      FROM (
        SELECT pz.product_id, SUM(m.signo * pz.unidades)::int AS delta
        FROM movidas m JOIN piezas pz ON pz.item_id = m."id"
        WHERE m.signo <> 0
        GROUP BY pz.product_id
      ) AS s
      WHERE p."id" = s.product_id`
    // Sacar de 'entregado' resta del depósito: si eso ya se vendió, el stock quedaría en
    // negativo, o sea, afirmaría que se vendió lo que no existía. Se revierte todo.
    const negativos = await tx.product.findMany({
      where: { id: { in: [...new Set(piezas.map(p => p.productId))] }, stock: { lt: 0 } },
      select: { nameEs: true, bajajCode: true },
      take: 3,
    })
    if (negativos.length > 0) {
      throw new ErrorDeNegocio(
        `No se puede sacar de entregado: ya no hay en stock lo que esta línea sumó ` +
        `(${negativos.map(n => n.bajajCode ?? n.nameEs).join(', ')}). Se vendió o se ajustó a mano; corregí ese stock primero.`,
      )
    }
  }, { maxWait: 10_000, timeout: 20_000 })
}
