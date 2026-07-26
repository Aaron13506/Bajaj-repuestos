// Backup puntual de las tablas que toca la migración logística (Pedido, PedidoItem,
// Envio, Supplier). Escribe un JSON con timestamp para poder restaurar a mano si algo
// sale mal. Destino: BACKUP_DIR si está seteada, si no ./backups.
//
//   npx tsx scripts/backup-logistics.ts
import { PrismaClient } from '@prisma/client'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const db = new PrismaClient()

async function main() {
  const [pedidos, items, envios, suppliers] = await Promise.all([
    db.pedido.findMany(),
    db.pedidoItem.findMany(),
    db.envio.findMany(),
    db.supplier.findMany(),
  ])

  const dir = process.env.BACKUP_DIR ?? join(process.cwd(), 'backups')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = join(dir, `backup-logistics-${stamp}.json`)
  writeFileSync(out, JSON.stringify({ pedidos, items, envios, suppliers }, null, 2))

  console.log(`Backup escrito en: ${out}`)
  console.log(`  Pedido:     ${pedidos.length}`)
  console.log(`  PedidoItem: ${items.length}`)
  console.log(`  Envio:      ${envios.length}`)
  console.log(`  Supplier:   ${suppliers.length}`)

  // Distribución de etapas. Vive en PedidoItem: el estado logístico es por línea,
  // no por pedido (un presupuesto puede estar comprado a medias).
  const porEstado = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.shippingStatus] = (acc[it.shippingStatus] ?? 0) + 1
    return acc
  }, {})
  console.log('  Etapas actuales:', porEstado)
  console.log('  Ítems con envío:', items.filter(it => it.envioId != null).length)
}

main().finally(() => db.$disconnect())
