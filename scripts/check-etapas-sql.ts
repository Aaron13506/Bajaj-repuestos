/**
 * Prueba el SQL que mueve líneas de etapa y acredita el stock (lib/mover-etapas.ts, el corazón de
 * saveItemChanges) contra la base LOCAL de Docker. Es lo único del stock que check:costeo no puede
 * cubrir: ahí son reglas puras; acá son una sentencia con CTEs y una escritura condicionada, y si
 * alguien les saca la condición (`shippingStatus = desde`), un doble click suma el stock dos veces
 * sin que nada falle.
 *
 *   pnpm check:etapas      (con pnpm db:up)
 *
 * Crea sus propias filas y las borra al final. Se niega a correr contra cualquier base que no sea
 * localhost:5432: el túnel a producción también es localhost (puerto 15432).
 */
try { process.loadEnvFile() } catch {}

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x@nada/x')
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || (url.port || '5432') !== '5432') {
    console.error(`✗ Esto escribe filas de prueba: solo corre contra la base de Docker (localhost:5432), no contra ${url.hostname}:${url.port}.`)
    process.exit(2)
  }
  // Después del chequeo: lib/db lee DATABASE_URL al importarse.
  const { db } = await import('../lib/db')
  const { moverEtapas } = await import('../lib/mover-etapas')
  const { ErrorDeNegocio } = await import('../lib/action-result')

  let fallas = 0
  const check = (nombre: string, real: unknown, esperado: unknown) => {
    const ok = real === esperado
    if (!ok) fallas++
    console.log(`  ${ok ? '✓' : '✗'} ${nombre.padEnd(62)} ${String(real)}${ok ? '' : `  esperado ${String(esperado)}`}`)
  }

  const product = await db.product.create({ data: { nameEs: '__check-etapas', price: 0, stock: 0 } })
  const envio = await db.envio.create({ data: { nombre: '__check-etapas', modo: 'aereo', estado: 'confirmado' } })
  const pedido = await db.pedido.create({
    data: {
      clientName: '__check-etapas', tipo: 'propio', status: 'pedido',
      items: { create: [{ productId: product.id, quantity: 3, salePrice: 0, shippingStatus: 'en_venezuela', envioId: envio.id }] },
    },
    include: { items: true },
  })
  const itemId = pedido.items[0].id
  const piezas = [{ itemId, productId: product.id, unidades: 3 }]
  const estado = async () => {
    const [p, it, etapas] = await Promise.all([
      db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stock: true } }),
      db.pedidoItem.findUniqueOrThrow({ where: { id: itemId }, select: { shippingStatus: true } }),
      db.pedidoItemEtapa.count({ where: { itemId } }),
    ])
    return { stock: p.stock, etapa: it.shippingStatus, etapas }
  }

  try {
    console.log('\nENTREGAR DOS VECES A LA VEZ (doble click, dos pestañas)')
    const llegar = { id: itemId, desde: 'en_venezuela', hacia: 'entregado', signo: 1 }
    await Promise.all([moverEtapas(envio.id, [llegar], piezas), moverEtapas(envio.id, [llegar], piezas)])
    let e = await estado()
    check('el stock sube UNA vez', e.stock, 3)
    check('la línea quedó entregada', e.etapa, 'entregado')
    check('una sola fila de historial', e.etapas, 1)

    console.log('\nSACAR DE ENTREGADO CUANDO YA SE VENDIÓ PARTE')
    await db.product.update({ where: { id: product.id }, data: { stock: 1 } })
    const volver = { id: itemId, desde: 'entregado', hacia: 'en_venezuela', signo: -1 }
    let rechazo = false
    try {
      await moverEtapas(envio.id, [volver], piezas)
    } catch (err) {
      rechazo = err instanceof ErrorDeNegocio
    }
    e = await estado()
    check('se rechaza con un motivo legible', rechazo, true)
    check('el stock no se tocó', e.stock, 1)
    check('la línea sigue entregada', e.etapa, 'entregado')
    check('no quedó historial de un cambio que no pasó', e.etapas, 1)

    console.log('\nSACAR DE ENTREGADO CON EL STOCK COMPLETO')
    await db.product.update({ where: { id: product.id }, data: { stock: 3 } })
    await moverEtapas(envio.id, [volver], piezas)
    e = await estado()
    check('el stock baja lo que sumó', e.stock, 0)
    check('la línea volvió', e.etapa, 'en_venezuela')
    check('dos filas de historial', e.etapas, 2)
  } finally {
    await db.pedido.delete({ where: { id: pedido.id } })
    await db.envio.delete({ where: { id: envio.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.$disconnect()
  }

  console.log(fallas === 0 ? '\n✅ todo ok' : `\n❌ ${fallas} falla(s)`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
