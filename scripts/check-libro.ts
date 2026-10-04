// ─────────────────────────────────────────────────────────────────────────────
// Coherencia del libro de movimientos. SOLO LEE.
//
// `Pedido.depositUsd` es una caché de "total cobrado" y el libro es la fuente de verdad: las
// dos tienen que decir lo mismo. Varias acciones las movían por separado y se fueron
// desfasando (un ingreso cargado desde Contabilidad no sumaba al depósito; corregir un
// adelanto a la baja dejaba el movimiento original). Las acciones de ahora pasan por
// registrarIngresoPedido / descontarIngresosPedido, que las mueven juntas — este chequeo
// existe para detectar lo que quedó torcido de antes, y para que cualquier camino nuevo que
// las desincronice salte en vez de pasar inadvertido.
//
// No corrige nada: un desfase puede ser un depósito mal cargado o un movimiento que falta, y
// cuál de los dos es lo decide quien conoce el cobro, no un script.
//
//   pnpm check:libro
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../lib/db'

const usd = (n: number) => `$${n.toFixed(2)}`
const dec = (v: { toString(): string } | null | undefined) => (v != null ? parseFloat(v.toString()) : 0)
let problemas = 0

async function main() {
  // ── 1. Depósito vs ingresos del libro, por pedido ─────────────────────────
  console.log('DEPÓSITO DE CADA PEDIDO vs SUS INGRESOS EN EL LIBRO')
  const [pedidos, ingresos] = await Promise.all([
    db.pedido.findMany({
      where: { tipo: { not: 'propio' } },
      select: { id: true, clientName: true, status: true, depositUsd: true },
    }),
    db.movimiento.groupBy({
      by: ['pedidoId'],
      where: { tipo: 'ingreso', pedidoId: { not: null } },
      _sum: { monto: true },
    }),
  ])
  const enLibro = new Map(ingresos.map(i => [i.pedidoId!, dec(i._sum.monto)]))

  const desfasados = pedidos
    .map(p => ({ p, deposito: dec(p.depositUsd), libro: enLibro.get(p.id) ?? 0 }))
    .filter(x => Math.abs(x.deposito - x.libro) > 0.01)
    .sort((a, b) => Math.abs(b.deposito - b.libro) - Math.abs(a.deposito - a.libro))

  if (desfasados.length === 0) {
    console.log(`  ✓ los ${pedidos.length} pedidos de cliente coinciden con el libro`)
  } else {
    problemas += desfasados.length
    console.log(`  ✗ ${desfasados.length} de ${pedidos.length} pedidos no coinciden:\n`)
    console.log('  pedido  cliente                      estado        depósito      libro   diferencia')
    for (const { p, deposito, libro } of desfasados) {
      console.log(
        `  #${String(p.id).padEnd(6)} ${p.clientName.slice(0, 27).padEnd(28)} ${p.status.padEnd(12)} ` +
        `${usd(deposito).padStart(9)} ${usd(libro).padStart(10)} ${usd(deposito - libro).padStart(12)}`,
      )
    }
    console.log('\n  depósito > libro: se cobró y no quedó en el libro (o un adelanto bajado a mano).')
    console.log('  depósito < libro: hay ingresos en el libro que el pedido no muestra.')
  }

  // ── 2. Ingresos ligados a un pedido que ya no existe ──────────────────────
  // El FK es SetNull: borrar un pedido deja el ingreso suelto. Si el chequeo de borrado
  // funciona, esto no debería crecer.
  console.log('\nINGRESOS SIN PEDIDO')
  const sueltos = await db.movimiento.findMany({
    where: { tipo: 'ingreso', pedidoId: null, categoria: { in: ['adelanto_cliente', 'pago_cliente'] } },
    select: { id: true, fecha: true, monto: true, categoria: true, descripcion: true },
    orderBy: { fecha: 'desc' },
    take: 20,
  })
  if (sueltos.length === 0) {
    console.log('  ✓ ningún cobro de cliente quedó sin pedido')
  } else {
    problemas += sueltos.length
    console.log(`  ✗ ${sueltos.length} cobro(s) de cliente sin pedido (los más recientes):`)
    for (const m of sueltos) {
      console.log(`    #${m.id} ${m.fecha.toISOString().slice(0, 10)} ${m.categoria.padEnd(16)} ${usd(dec(m.monto))} ${m.descripcion ?? ''}`)
    }
  }

  // ── 3. Stock negativo ─────────────────────────────────────────────────────
  console.log('\nSTOCK NEGATIVO')
  const negativos = await db.product.findMany({
    where: { stock: { lt: 0 } },
    select: { id: true, bajajCode: true, nameEs: true, stock: true },
    orderBy: { stock: 'asc' },
    take: 20,
  })
  if (negativos.length === 0) {
    console.log('  ✓ ningún producto con stock negativo')
  } else {
    problemas += negativos.length
    console.log(`  ✗ ${negativos.length} producto(s) con stock negativo:`)
    for (const p of negativos) console.log(`    ${String(p.stock).padStart(5)}  ${p.bajajCode ?? '—'}  ${p.nameEs}`)
  }

  // ── 4. Pagos al proveedor que no son de pago ──────────────────────────────
  // Un flete anotado contra una caja con proveedor no cuenta como pagado al proveedor (ver
  // CATEGORIAS_PAGO_PROVEEDOR). Informativo: es lo que cambió de cifra en "Cuentas por pagar".
  console.log('\nEGRESOS DE UNA CAJA QUE NO SALDAN AL PROVEEDOR (informativo)')
  const otros = await db.movimiento.groupBy({
    by: ['categoria'],
    where: { tipo: 'egreso', envioId: { not: null }, categoria: { notIn: ['pago_proveedor', 'comision_giro'] } },
    _sum: { monto: true },
    _count: true,
  })
  if (otros.length === 0) console.log('  — ninguno')
  for (const o of otros) console.log(`  ${o.categoria.padEnd(16)} ${String(o._count).padStart(3)} movimientos · ${usd(dec(o._sum.monto))}`)

  console.log(`\n${problemas === 0 ? '✅ el libro es coherente' : `⚠️  ${problemas} hallazgo(s) a revisar`}\n`)
  await db.$disconnect()
  process.exit(problemas === 0 ? 0 : 1)
}

main().catch(async e => {
  console.error(e)
  await db.$disconnect()
  process.exit(2)
})
