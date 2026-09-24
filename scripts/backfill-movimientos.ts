/**
 * Backfill del libro de movimientos: crea un Movimiento (ingreso, adelanto_cliente) por
 * cada Pedido confirmado ('pedido') con depositUsd cargado que todavía no tiene ningún
 * Movimiento — el histórico que se anotó a mano en depositUsd antes de que existiera el
 * libro. Idempotente: una segunda corrida no duplica nada porque filtra por
 * `movimientos: { none: {} }`.
 *
 * No hay backfill del lado de egresos: nunca se registraron en ningún lado (ver
 * CLAUDE.md / plan de contabilidad), así que no hay de dónde reconstruirlos. El saldo de
 * caja solo es exacto desde el día en que se empiece a cargar el libro para adelante.
 *
 * Requiere Node >= 20.12 (process.loadEnvFile).
 *
 * Uso:
 *   pnpm exec tsx scripts/backfill-movimientos.ts            # DRY-RUN
 *   pnpm exec tsx scripts/backfill-movimientos.ts --apply    # ejecuta
 */
import { PrismaClient } from '@prisma/client'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})
const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(APPLY ? '── MODO APPLY ──' : '── DRY-RUN ──')

  const pedidos = await prisma.pedido.findMany({
    where: { status: 'pedido', depositUsd: { not: null }, movimientos: { none: {} } },
    select: { id: true, clientName: true, depositUsd: true, paymentMethod: true, depositAt: true, createdAt: true },
  })

  console.log(`Pedidos con adelanto sin movimiento en el libro: ${pedidos.length}`)
  for (const p of pedidos) {
    console.log(`  · #${p.id} ${p.clientName} — $${p.depositUsd} (${(p.depositAt ?? p.createdAt).toISOString().slice(0, 10)})`)
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: correr con --apply para ejecutar.')
    return
  }

  let creados = 0
  for (const p of pedidos) {
    await prisma.movimiento.create({
      data: {
        fecha: p.depositAt ?? p.createdAt,
        tipo: 'ingreso',
        categoria: 'adelanto_cliente',
        monto: p.depositUsd!,
        metodoPago: p.paymentMethod,
        pedidoId: p.id,
      },
    })
    creados++
  }

  console.log(`\n✓ Listo. Movimientos creados: ${creados}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
