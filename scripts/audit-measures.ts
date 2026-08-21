// ─────────────────────────────────────────────────────────────────────────────
// Auditoría de peso y dimensiones del catálogo.
//
// El chequeo físico de lib/measures-check.ts corre al CARGAR, así que protege lo que
// entre de ahora en adelante. Esto es la otra mitad: revisar lo que ya está guardado,
// que entró cuando no había ningún control.
//
// Ordena por lo único que decide la prioridad: si la pieza SE MUEVE. Un dato absurdo en
// una pieza que nadie compró nunca no cuesta un peso; el mismo dato en una pieza que
// viajó en una caja se pagó en flete y se trasladó al precio de venta.
//
//   pnpm measures:audit           piezas con medidas cargadas
//   pnpm measures:audit --usadas  solo las que aparecen en un pedido o un embarque
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../lib/db'
import { chequearMedidas, densidad, type Chequeo } from '../lib/measures-check'

const soloUsadas = process.argv.includes('--usadas')

const pad = (s: string | number, n: number) => String(s).padStart(n)
const padR = (s: string | number, n: number) => String(s).padEnd(n)

async function main() {
  const [productos, pedidoItems, envioLineas] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: false },
      select: { id: true, nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
    }),
    db.pedidoItem.groupBy({ by: ['productId'], _sum: { quantity: true } }),
    db.envioLinea.groupBy({ by: ['productId'], _sum: { quantity: true } }),
  ])

  // Unidades que pasaron por un pedido o un embarque: la medida de cuánto importa la pieza.
  const uso = new Map<number, number>()
  for (const r of [...pedidoItems, ...envioLineas]) {
    uso.set(r.productId, (uso.get(r.productId) ?? 0) + (r._sum.quantity ?? 0))
  }

  const completa = (p: typeof productos[number]) => !!(p.weightGrams && p.dimL && p.dimA && p.dimH)
  const enUso = productos.filter(p => uso.has(p.id))

  console.log('── COBERTURA')
  console.log(`  Piezas del catálogo ......... ${productos.length}`)
  console.log(`  Con peso y dimensiones ...... ${productos.filter(completa).length}`)
  console.log(`  En algún pedido o embarque .. ${enUso.length}`)
  console.log(`  ...de esas, sin medir ....... ${enUso.filter(p => !completa(p)).length}  ← estas ya cuestan plata`)

  const sinMedir = enUso.filter(p => !completa(p))
  if (sinMedir.length > 0) {
    console.log(`\n── EN USO Y SIN MEDIR (${sinMedir.length}) — el envío que las lleve se costea de menos`)
    console.log(`  ${padR('uds', 5)}${padR('falta', 12)}${padR('SKU', 14)}nombre`)
    for (const p of sinMedir.sort((a, b) => (uso.get(b.id) ?? 0) - (uso.get(a.id) ?? 0)).slice(0, 40)) {
      const falta = !p.weightGrams && !p.dimL ? 'peso+dims' : !p.weightGrams ? 'peso' : 'dims'
      console.log(`  ${padR(uso.get(p.id) ?? 0, 5)}${padR(falta, 12)}${padR(p.bajajCode ?? '—', 14)}${p.nameEs.slice(0, 50)}`)
    }
    if (sinMedir.length > 40) console.log(`  … y ${sinMedir.length - 40} más`)
  }

  // ── Chequeo físico de lo ya cargado ────────────────────────────────────────
  const universo = (soloUsadas ? enUso : productos).filter(completa)
  const hallazgos = universo
    .map(p => ({ p, cs: chequearMedidas(p), uds: uso.get(p.id) ?? 0 }))
    .filter(x => x.cs.length > 0)
    // Primero lo que se mueve, después lo grave: una pieza que viajó con un dato
    // imposible ya se cobró mal, la que nunca se compró solo está esperando.
    .sort((a, b) =>
      b.uds - a.uds ||
      Number(b.cs.some(c => c.severidad === 'error')) - Number(a.cs.some(c => c.severidad === 'error')))

  const errores = hallazgos.filter(x => x.cs.some(c => c.severidad === 'error'))
  console.log(`\n── CHEQUEO FÍSICO sobre ${universo.length} piezas medidas${soloUsadas ? ' (solo en uso)' : ''}`)
  console.log(`  Imposibles (no deberían estar en la base): ${errores.length}`)
  console.log(`  Con aviso: ${hallazgos.length - errores.length}`)

  if (hallazgos.length > 0) {
    console.log(`\n  ${padR('uds', 5)}${pad('g', 7)} ${padR('dims (cm)', 16)}${pad('g/cm³', 7)}  ${padR('SKU', 13)}nombre`)
    for (const { p, cs, uds } of hallazgos) {
      const d = densidad(p)
      const grave = cs.some((c: Chequeo) => c.severidad === 'error')
      console.log(
        `  ${padR(uds || '·', 5)}${pad(p.weightGrams!, 7)} ${padR(`${p.dimL}×${p.dimA}×${p.dimH}`, 16)}` +
        `${pad(d != null ? d.toFixed(3) : '—', 7)}  ${padR(p.bajajCode ?? '—', 13)}${p.nameEs.slice(0, 42)}`)
      for (const c of cs) {
        console.log(`        ${grave && c.severidad === 'error' ? '✗' : '⚠'} ${c.mensaje}`)
      }
    }
  }

  console.log(
    `\nLas marcadas con ✗ no las aceptaría hoy el cargador. Recargalas con MedidasIA desde ` +
    `la ficha del ensamble que las contiene.`)
}

main().then(() => process.exit(0))
