// Chequeo post-migración: confirma que el eje logístico quedó bien asentado en
// PedidoItem y que ningún pedido perdió su estado en el camino.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const [porEstado, porOrigen, conEnvio, pedidos] = await Promise.all([
    db.pedidoItem.groupBy({ by: ['shippingStatus'], _count: true }),
    db.pedidoItem.groupBy({ by: ['origen'], _count: true }),
    db.pedidoItem.count({ where: { envioId: { not: null } } }),
    db.pedido.findMany({
      select: { id: true, clientName: true, status: true, items: { select: { shippingStatus: true } } },
      orderBy: { id: 'asc' },
    }),
  ])

  console.log('Ítems por etapa:')
  for (const r of porEstado) console.log(`  ${r.shippingStatus.padEnd(18)} ${r._count}`)
  console.log('\nÍtems por origen:')
  for (const r of porOrigen) console.log(`  ${r.origen.padEnd(18)} ${r._count}`)
  console.log(`\nÍtems asignados a un envío: ${conEnvio}`)

  // Pedidos parcialmente comprados: el caso que antes no se podía representar.
  const parciales = pedidos.filter(p => {
    const pend = p.items.filter(i => i.shippingStatus === 'pendiente').length
    return pend > 0 && pend < p.items.length
  })
  console.log(`\nPedidos comprados a medias (antes imposible de modelar): ${parciales.length}`)
  for (const p of parciales) {
    const pend = p.items.filter(i => i.shippingStatus === 'pendiente').length
    console.log(`  #${p.id} ${p.clientName}: ${p.items.length - pend}/${p.items.length} comprados`)
  }

  const huerfanos = await db.pedidoItem.count({ where: { shippingStatus: { notIn: [
    'pendiente', 'camino_shoppre', 'en_shoppre', 'camino_usa', 'en_usa',
    'camino_venezuela', 'en_venezuela', 'entregado',
  ] } } })
  console.log(`\nÍtems con etapa inválida: ${huerfanos}`)
  if (huerfanos > 0) throw new Error('Hay ítems con un shippingStatus fuera del pipeline.')
  console.log('✓ Verificación OK.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
