// Migración de datos: baja el eje logístico de Pedido a PedidoItem.
//
// Hasta ahora el envío y la etapa de transporte vivían en el Pedido, lo que asumía que
// un presupuesto se compraba entero, de un solo proveedor y viajaba en una sola caja.
// Cada ítem hereda ahora los valores que tenía su pedido, así que el estado visible no
// cambia: lo que antes era "el pedido está en camino a Shoppre" pasa a ser "todos sus
// ítems están en camino a Shoppre". A partir de ahí ya se pueden mover por separado.
//
// Idempotente: se puede correr varias veces mientras Pedido conserve las columnas
// viejas (fase B). Después de la fase C (drop) deja de aplicar.
//
//   npx tsx scripts/migrate-logistics-to-items.ts
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // Después de la fase C las columnas viejas ya no existen: no hay nada que migrar.
  const existe = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_name = 'Pedido' AND column_name = 'shippingStatus'
  `
  if (Number(existe[0].n) === 0) {
    console.log('Pedido ya no tiene columnas logísticas: la migración ya se aplicó. Nada que hacer.')
    return
  }

  const antes = await db.$queryRaw<{ shippingStatus: string; n: bigint }[]>`
    SELECT "shippingStatus", COUNT(*) AS n FROM "Pedido" GROUP BY "shippingStatus" ORDER BY 1
  `
  console.log('Estados en Pedido (origen):')
  for (const r of antes) console.log(`  ${r.shippingStatus.padEnd(18)} ${r.n}`)

  const filas = await db.$executeRaw`
    UPDATE "PedidoItem" pi
       SET "envioId"          = p."envioId",
           "shippingStatus"   = p."shippingStatus",
           "shippingStatusAt" = p."shippingStatusAt"
      FROM "Pedido" p
     WHERE pi."pedidoId" = p.id
  `
  console.log(`\nÍtems actualizados: ${filas}`)

  const despues = await db.$queryRaw<{ shippingStatus: string; n: bigint }[]>`
    SELECT "shippingStatus", COUNT(*) AS n FROM "PedidoItem" GROUP BY "shippingStatus" ORDER BY 1
  `
  console.log('\nEstados en PedidoItem (destino):')
  for (const r of despues) console.log(`  ${r.shippingStatus.padEnd(18)} ${r.n}`)

  // Verificación: ningún ítem puede quedar desalineado de su pedido.
  const desalineados = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n
      FROM "PedidoItem" pi
      JOIN "Pedido" p ON p.id = pi."pedidoId"
     WHERE pi."shippingStatus" IS DISTINCT FROM p."shippingStatus"
        OR pi."envioId"        IS DISTINCT FROM p."envioId"
  `
  const n = Number(desalineados[0].n)
  console.log(`\nÍtems desalineados respecto de su pedido: ${n}`)
  if (n > 0) throw new Error('La migración no dejó todos los ítems alineados — revisar antes de seguir.')
  console.log('✓ Migración verificada.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
