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
  const { moverStock, StockInsuficiente } = await import('../lib/stock')

  let fallas = 0
  const check = (nombre: string, real: unknown, esperado: unknown) => {
    const ok = real === esperado
    if (!ok) fallas++
    console.log(`  ${ok ? '✓' : '✗'} ${nombre.padEnd(62)} ${String(real)}${ok ? '' : `  esperado ${String(esperado)}`}`)
  }

  const product = await db.product.create({ data: { nameEs: '__check-etapas', price: 0 } })
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
  // Movimientos del kardex que dejó la línea, y si la caché coincide con el libro.
  const kardex = async () => {
    const [movs, suma, p] = await Promise.all([
      db.movimientoStock.findMany({ where: { pedidoItemId: itemId }, select: { cantidad: true, motivo: true }, orderBy: { id: 'asc' } }),
      db.movimientoStock.aggregate({ where: { productId: product.id }, _sum: { cantidad: true } }),
      db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stock: true } }),
    ])
    return { movs: movs.map(m => `${m.motivo}${m.cantidad > 0 ? '+' : ''}${m.cantidad}`).join(' '), cuadra: (suma._sum.cantidad ?? 0) === p.stock }
  }
  const ajustar = (cantidad: number) => moverStock(db, [{ productId: product.id, cantidad, motivo: 'ajuste', nota: 'check-etapas' }])

  const limpiar: (() => Promise<void>)[] = []
  try {
    console.log('\nENTREGAR DOS VECES A LA VEZ (doble click, dos pestañas)')
    const llegar = { id: itemId, desde: 'en_venezuela', hacia: 'entregado', signo: 1 }
    await Promise.all([moverEtapas(envio.id, [llegar], piezas), moverEtapas(envio.id, [llegar], piezas)])
    let e = await estado()
    check('el stock sube UNA vez', e.stock, 3)
    check('la línea quedó entregada', e.etapa, 'entregado')
    check('una sola fila de historial', e.etapas, 1)
    let k = await kardex()
    check('UN movimiento de kardex +3', k.movs, 'entrega_propio+3')
    check('stock = suma del kardex', k.cuadra, true)

    console.log('\nSACAR DE ENTREGADO CUANDO YA SE VENDIÓ PARTE')
    await ajustar(-2)
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
    k = await kardex()
    check('ningún movimiento de kardex nuevo', k.movs, 'entrega_propio+3')
    check('stock = suma del kardex', k.cuadra, true)

    console.log('\nSACAR DE ENTREGADO CON EL STOCK COMPLETO')
    await ajustar(2)
    await moverEtapas(envio.id, [volver], piezas)
    e = await estado()
    check('el stock baja lo que sumó', e.stock, 0)
    check('la línea volvió', e.etapa, 'en_venezuela')
    check('dos filas de historial', e.etapas, 2)
    k = await kardex()
    check('el kardex tiene la reversa −3', k.movs, 'entrega_propio+3 reversa_entrega_propio-3')
    check('stock = suma del kardex', k.cuadra, true)

    console.log('\nKARDEX: STOCK QUE NO ALCANZA')
    let insuficiente: unknown = null
    try {
      await moverStock(db, [{ productId: product.id, cantidad: -1, motivo: 'venta' }])
    } catch (err) {
      insuficiente = err
    }
    check('la base lo rechaza como StockInsuficiente', insuficiente instanceof StockInsuficiente, true)
    check('nombra la pieza', insuficiente instanceof StockInsuficiente && insuficiente.piezas.join(), '__check-etapas')
    check('stock = suma del kardex', (await kardex()).cuadra, true)

    console.log('\nRECEPCIÓN: LECTURAS A LA VEZ, CERRAR DOS VECES, REVERTIR')
    const rec = await import('../lib/recepcion-db')
    const pz = await db.product.create({ data: { nameEs: '__check-recepcion', bajajCode: 'ZZCHK9001', price: 0 } })
    const caja = await db.envio.create({ data: { nombre: '__check-recepcion', modo: 'aereo', estado: 'confirmado' } })
    limpiar.push(async () => {
      await db.movimientoStock.deleteMany({ where: { productId: pz.id } })
      await db.recepcion.deleteMany({ where: { envioId: caja.id } })
      await db.pedido.deleteMany({ where: { clientName: '__check-recepcion' } })
      await db.envio.delete({ where: { id: caja.id } })
      await db.product.delete({ where: { id: pz.id } })
    })
    const cliente = await db.pedido.create({
      data: { clientName: '__check-recepcion', tipo: 'cliente', status: 'pedido', items: { create: [{ productId: pz.id, quantity: 2, salePrice: 0, shippingStatus: 'camino_venezuela', envioId: caja.id, costRealUsd: 1 }] } },
      include: { items: true },
    })
    const propio = await db.pedido.create({
      data: { clientName: '__check-recepcion', tipo: 'propio', status: 'pedido', items: { create: [{ productId: pz.id, quantity: 2, salePrice: 0, shippingStatus: 'camino_venezuela', envioId: caja.id, costRealUsd: 1 }] } },
      include: { items: true },
    })
    const etapaDe = async (id: number) => (await db.pedidoItem.findUniqueOrThrow({ where: { id }, select: { shippingStatus: true } })).shippingStatus
    const stockPz = async () => (await db.product.findUniqueOrThrow({ where: { id: pz.id }, select: { stock: true } })).stock
    const cuadraPz = async () => ((await db.movimientoStock.aggregate({ where: { productId: pz.id }, _sum: { cantidad: true } }))._sum.cantidad ?? 0) === await stockPz()

    const recId = (await rec.abrirRecepcion(caja.id, { llegada: true }))!
    const filas = await db.recepcionLinea.findMany({ where: { recepcionId: recId } })
    check('abre con una fila de 4 esperadas', filas.length === 1 && filas[0].esperado === 4, true)
    check('abrir otra vez devuelve la misma', await rec.abrirRecepcion(caja.id), recId)

    await Promise.all([1, 2, 3].map(() => rec.registrarLectura(recId, 'ZZCHK9001-1_10', 'camara')))
    const fila = await db.recepcionLinea.findUniqueOrThrow({ where: { id: filas[0].id } })
    check('tres lecturas a la vez suman 3', fila.contado, 3)
    check('y dejan tres lecturas', await db.recepcionLectura.count({ where: { lineaId: fila.id } }), 3)

    let sinDecidir = ''
    try { await rec.cerrarRecepcion(recId, {}) } catch (err) { sinDecidir = err instanceof ErrorDeNegocio ? 'negocio' : 'otro' }
    check('sin decidir el faltante no cierra', sinDecidir, 'negocio')

    const cierres = await Promise.allSettled([1, 2].map(() => rec.cerrarRecepcion(recId, { [fila.id]: 'backorder' })))
    check('cerrar dos veces: una sola vez', cierres.filter(c => c.status === 'fulfilled').length, 1)
    const segundo = cierres.find(c => c.status === 'rejected') as PromiseRejectedResult | undefined
    check('la otra se rechaza legible', segundo?.reason instanceof ErrorDeNegocio, true)
    check('el stock sube lo que cubrió al propio (1)', await stockPz(), 1)
    check('un solo movimiento de recepción', await db.movimientoStock.count({ where: { recepcionId: recId } }), 1)
    check('una sola incidencia (backorder del propio)', (await db.incidencia.findMany({ where: { recepcionId: recId } })).map(i => `${i.tipo}:${i.cantidad}:${i.itemId === propio.items[0].id}`).join(), 'sin_enviar:1:true')
    check('cliente → en_venezuela', await etapaDe(cliente.items[0].id), 'en_venezuela')
    check('propio → entregado', await etapaDe(propio.items[0].id), 'entregado')
    check('stock = suma del kardex', await cuadraPz(), true)
    check('el stepper ya no deja volver a mano', rec !== null && (await import('../lib/recepcion')).transicionManualPermitida('en_venezuela', 'camino_venezuela', { isLanded: false, esCliente: true }), false)

    console.log('\nREVERTIR CON EL STOCK YA VENDIDO')
    await moverStock(db, [{ productId: pz.id, cantidad: -1, motivo: 'ajuste', nota: 'check-etapas' }])
    let motivo = ''
    try { await rec.revertirRecepcion(recId) } catch (err) { motivo = err instanceof ErrorDeNegocio ? 'negocio' : String(err) }
    check('se rechaza con un motivo legible', motivo, 'negocio')
    check('la recepción sigue cerrada sin revertir', (await db.recepcion.findUniqueOrThrow({ where: { id: recId } })).revertidaAt, null)
    check('las líneas no se movieron', `${await etapaDe(cliente.items[0].id)} ${await etapaDe(propio.items[0].id)}`, 'en_venezuela entregado')
    check('la incidencia sigue', await db.incidencia.count({ where: { recepcionId: recId } }), 1)
    check('stock = suma del kardex', await cuadraPz(), true)

    console.log('\nREVERTIR CON UNA INCIDENCIA YA RESUELTA')
    await moverStock(db, [{ productId: pz.id, cantidad: 1, motivo: 'ajuste', nota: 'check-etapas' }])
    await db.incidencia.updateMany({ where: { recepcionId: recId }, data: { estado: 'resuelta', resolucion: 'llego', resueltaAt: new Date() } })
    motivo = ''
    try { await rec.revertirRecepcion(recId) } catch (err) { motivo = err instanceof ErrorDeNegocio ? 'negocio' : String(err) }
    check('se rechaza', motivo, 'negocio')
    check('el stock no se tocó', await stockPz(), 1)

    console.log('\nREVERTIR BIEN')
    await db.incidencia.updateMany({ where: { recepcionId: recId }, data: { estado: 'abierta', resolucion: null, resueltaAt: null } })
    const nueva = await rec.revertirRecepcion(recId)
    check('el stock vuelve a 0', await stockPz(), 0)
    check('stock = suma del kardex', await cuadraPz(), true)
    check('las líneas vuelven a camino_venezuela', `${await etapaDe(cliente.items[0].id)} ${await etapaDe(propio.items[0].id)}`, 'camino_venezuela camino_venezuela')
    check('sus incidencias se borran', await db.incidencia.count({ where: { recepcionId: recId } }), 0)
    check('abre una recepción nueva con todo lo esperado', (await db.recepcionLinea.findMany({ where: { recepcionId: nueva ?? -1 } })).map(l => l.esperado).join(), '4')
  } finally {
    for (const f of limpiar) await f()
    await db.movimientoStock.deleteMany({ where: { productId: product.id } })
    await db.pedido.delete({ where: { id: pedido.id } })
    await db.envio.delete({ where: { id: envio.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.$disconnect()
  }

  console.log(fallas === 0 ? '\n✅ todo ok' : `\n❌ ${fallas} falla(s)`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
