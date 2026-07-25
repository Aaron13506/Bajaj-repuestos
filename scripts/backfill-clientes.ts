/**
 * Backfill de la entidad Cliente: crea un Cliente por cada clientName distinto
 * (case-insensitive, trimmed) entre los Pedido que todavía no tienen clienteId, y los
 * vincula. Excluye tipo 'propio' (stock propio, no lleva Cliente) y los clientName
 * vacíos (no se crea un Cliente sin nombre).
 *
 * Requiere Node >= 20.12 (process.loadEnvFile).
 *
 * Uso:
 *   pnpm exec tsx scripts/backfill-clientes.ts            # DRY-RUN
 *   pnpm exec tsx scripts/backfill-clientes.ts --apply    # ejecuta
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
    where: { tipo: { not: 'propio' }, clienteId: null },
    select: { id: true, clientName: true },
  })

  const porNombre = new Map<string, { nombre: string; ids: number[] }>()
  const sinNombre: number[] = []
  for (const p of pedidos) {
    const nombre = p.clientName.trim()
    // Sin nombre no hay Cliente que crear: se listan y se dejan con clienteId null
    // para revisarlos a mano.
    if (!nombre) {
      sinNombre.push(p.id)
      continue
    }
    const key = nombre.toLowerCase()
    const entry = porNombre.get(key)
    if (entry) entry.ids.push(p.id)
    else porNombre.set(key, { nombre, ids: [p.id] })
  }

  console.log(`Pedidos sin cliente vinculado: ${pedidos.length}`)
  console.log(`Nombres distintos: ${porNombre.size}`)
  if (sinNombre.length) {
    console.log(`⚠ Pedidos con clientName vacío (se saltean): ${sinNombre.join(', ')}`)
  }

  if (!APPLY) {
    for (const { nombre, ids } of porNombre.values()) {
      console.log(`  · "${nombre}" → ${ids.length} pedido(s)`)
    }
    console.log('\nDRY-RUN: correr con --apply para ejecutar.')
    return
  }

  let creados = 0
  let vinculados = 0
  for (const { nombre, ids } of porNombre.values()) {
    const existing = await prisma.cliente.findFirst({ where: { nombre: { equals: nombre, mode: 'insensitive' } } })
    const cliente = existing ?? await prisma.cliente.create({ data: { nombre } })
    if (!existing) creados++

    const res = await prisma.pedido.updateMany({
      where: { id: { in: ids } },
      data: { clienteId: cliente.id },
    })
    vinculados += res.count
  }

  console.log(`\n✓ Listo. Clientes creados: ${creados} · Pedidos vinculados: ${vinculados}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
