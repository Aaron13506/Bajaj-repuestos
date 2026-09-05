/**
 * Consulta rápida del catálogo: peso, medidas y volumen sin abrir la app.
 *
 *   pnpm q sku JR131026 36DH4174           # ficha de uno o varios SKU
 *   pnpm q quote 36DH4174:9 JG571014:50    # totales de una lista SKU:cantidad
 *   pnpm q quote --file=lista.json         # o un JSON [{ "sku": "...", "qty": 9 }]
 *   echo '[...]' | pnpm q quote --file=-   # o por stdin
 *   pnpm q search "belly pan"              # buscar por nombre o SKU
 *   pnpm q missing --limit=30              # piezas sin peso o sin medidas
 *
 * Flags de `quote`: --inbound-china=USD (factura real del tramo China→USA),
 * --china=SKU,SKU (marca esas líneas como origen china), --json (salida cruda).
 */
import { db } from '@/lib/db'
import { loadConfig, quoteMetrics, resolveSkus, volumeOf, type SkuLine } from '@/lib/quote-metrics'

// ── formato ──────────────────────────────────────────────────────────────────
const n = (v: number, d = 2) => v.toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d })

function table(headers: string[], rows: (string | number)[][]) {
  if (rows.length === 0) return console.log('  (sin resultados)')
  const cells = rows.map(r => r.map(c => String(c)))
  const width = headers.map((h, i) => Math.max(h.length, ...cells.map(r => (r[i] ?? '').length)))
  // Las columnas numéricas se alinean a la derecha; el resto a la izquierda.
  const numeric = headers.map((_, i) => cells.every(r => r[i] === '—' || /^-?[\d.,]+$/.test(r[i] ?? '')))
  const line = (r: string[]) => '  ' + r.map((c, i) => numeric[i] ? c.padStart(width[i]) : c.padEnd(width[i])).join('  ').trimEnd()
  console.log(line(headers))
  console.log('  ' + width.map(w => '─'.repeat(w)).join('  '))
  for (const r of cells) console.log(line(r))
}

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) flags[m[1]] = m[2] ?? 'true'
    else rest.push(a)
  }
  return { flags, rest }
}

const readStdin = () => new Promise<string>(res => {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => { buf += d })
  process.stdin.on('end', () => res(buf))
})

// ── subcomandos ──────────────────────────────────────────────────────────────

async function cmdSku(args: string[]) {
  const { flags, rest } = parseFlags(args)
  if (rest.length === 0) return console.error('uso: pnpm q sku <SKU> [SKU...]')

  const found = await resolveSkus(rest)
  if (flags.json) return console.log(JSON.stringify([...found.values()], null, 2))

  const rows = rest.map(sku => {
    const p = found.get(sku.trim())
    if (!p) return [sku, 'NO ENCONTRADO', '—', '—', '—', '—', '—', '—']
    const v = volumeOf(p)
    const dims = p.dimL != null && p.dimA != null && p.dimH != null ? `${p.dimL}×${p.dimA}×${p.dimH}` : '—'
    return [
      p.bajajCode ?? sku,
      p.nameEs.slice(0, 38),
      p.weightGrams ?? '—',
      dims,
      v.cm3 ? n(v.ft3, 4) : '—',
      v.cm3 ? n(v.cbm, 5) : '—',
      p.priceInr ?? '—',
      p.stock,
    ]
  })
  table(['SKU', 'Nombre', 'gr', 'Medidas cm', 'ft³/u', 'CBM/u', '₹', 'Stock'], rows)

  const faltan = rest.filter(s => {
    const p = found.get(s.trim())
    return p && (p.weightGrams == null || p.dimL == null || p.dimA == null || p.dimH == null)
  })
  if (faltan.length) console.log(`\n  ⚠ sin peso o medidas: ${faltan.join(', ')}`)
}

async function cmdQuote(args: string[]) {
  const { flags, rest } = parseFlags(args)

  let lines: SkuLine[] = []
  if (flags.file) {
    const raw = flags.file === '-'
      ? await readStdin()
      : await (await import('node:fs/promises')).readFile(flags.file, 'utf8')
    lines = JSON.parse(raw)
  } else {
    // Formato posicional SKU:cantidad — sin cantidad se asume 1.
    lines = rest.map(a => {
      const [sku, qty] = a.split(':')
      return { sku, qty: qty ? Number(qty) : 1 }
    })
  }
  if (lines.length === 0) return console.error('uso: pnpm q quote <SKU:qty>... | --file=<ruta|->')

  // --china marca las líneas que despacha un proveedor por su cuenta (China, o cualquier
  // proveedor DDP tipo Garuda): ese tramo no tiene tabla, se paga el total que facturó.
  // Se le da un id de proveedor sintético para que caigan todas en el mismo grupo.
  const PROV_COTIZADO = -1
  const china = new Set((flags.china ?? '').split(',').filter(Boolean).map(s => s.toUpperCase()))
  if (china.size) {
    lines = lines.map(l => china.has(l.sku.toUpperCase())
      ? { ...l, origen: 'china' as const, inbound: 'cotizado' as const, supplierId: PROV_COTIZADO }
      : l)
  }

  const tramoUsd = flags['inbound-china'] ? Number(flags['inbound-china']) : null
  const r = await quoteMetrics(lines, {
    proveedor: china.size ? { supplierId: PROV_COTIZADO, nombre: 'Tramo cotizado', tramoUsd } : null,
  })
  if (flags.json) return console.log(JSON.stringify(r, null, 2))

  const b = r.breakdown
  table(
    ['SKU · Nombre', 'Qty', 'kg', 'volKg', 'ft³', 'CBM', 'USD'],
    b.lines.map((l, i) => [
      l.name.slice(0, 44),
      l.quantity,
      n(l.realKg, 3),
      n(l.volKg, 3),
      n(r.lineVolume[i].ft3, 4),
      n(r.lineVolume[i].cbm, 5),
      n(l.landedUsd),
    ]),
  )

  console.log(`\n  TOTALES  ${b.lines.length} líneas · ${r.units} unidades`)
  console.log(`  Peso real ......... ${n(b.realKg, 3)} kg`)
  console.log(`  Peso volumétrico .. ${n(b.volKg, 3)} kg   (divisor ${r.cfg.air_volumetric_divisor ?? '5000'})`)
  console.log(`  Cobrable .......... ${n(b.chargeableKg, 3)} kg  → ${b.binding === 'weight' ? 'peso real' : 'volumétrico'} manda`)
  console.log(`  Volumen ........... ${n(b.lines.length ? r.volume.ft3 : 0, 4)} ft³  ·  ${n(r.volume.cbm, 5)} CBM`)
  console.log(`  ─`)
  console.log(`  Producto .......... $${n(b.productCostUsd)}`)
  const cotizado = b.tramo ? ` · ${b.tramo.nombre} $${n(b.tramo.costUsd)}` : ''
  console.log(`  Aéreo a USA ....... $${n(b.airUsd)}   (Shoppre $${n(b.air.costUsd)}${cotizado})`)
  console.log(`  Marítimo .......... $${n(b.maritimeUsd)}   (${r.cfg.miami_caracas_per_ft3 ?? '45'} USD/ft³)`)
  console.log(`  Seguro + proc. .... $${n(b.insuranceUsd + b.processingUsd)}`)
  if (b.comisionUsd > 0) console.log(`  Comisiones giro ... $${n(b.comisionUsd)}`)
  console.log(`  LANDED ............ $${n(b.landedUsd)}`)

  if (r.notFound.length) console.log(`\n  ⚠ SKU no encontrados (${r.notFound.length}): ${r.notFound.join(', ')}`)
  const sinPeso = b.lines.filter(l => l.missingWeight).map(l => l.name.split(' · ')[0])
  const sinDims = b.lines.filter(l => l.missingDims).map(l => l.name.split(' · ')[0])
  if (sinPeso.length) console.log(`  ⚠ sin peso (${sinPeso.length}): ${sinPeso.join(', ')}`)
  if (sinDims.length) console.log(`  ⚠ sin medidas (${sinDims.length}): ${sinDims.join(', ')}`)
  if (sinPeso.length || sinDims.length) console.log(`  → los totales de arriba subestiman el envío real.`)
  if (b.tramo?.faltaCosto) {
    console.log(`  ⚠ ${b.tramo.nombre}: tramo sin costo cargado (--inbound-china), cuenta 0.`)
  }
}

async function cmdSearch(args: string[]) {
  const { flags, rest } = parseFlags(args)
  const q = rest.join(' ')
  if (!q) return console.error('uso: pnpm q search <texto>')
  const limit = Number(flags.limit ?? 25)

  const products = await db.product.findMany({
    where: {
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { nameEn: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: {
      bajajCode: true, nameEs: true, weightGrams: true,
      dimL: true, dimA: true, dimH: true, isAssembly: true, stock: true,
    },
    orderBy: { nameEs: 'asc' },
    take: limit,
  })

  if (flags.json) return console.log(JSON.stringify(products, null, 2))
  table(
    ['SKU', 'Nombre', 'Tipo', 'gr', 'Medidas cm', 'Stock'],
    products.map(p => [
      p.bajajCode ?? '—',
      p.nameEs.slice(0, 42),
      p.isAssembly ? 'ensamble' : 'pieza',
      p.weightGrams ?? '—',
      p.dimL != null && p.dimA != null && p.dimH != null ? `${p.dimL}×${p.dimA}×${p.dimH}` : '—',
      p.stock,
    ]),
  )
  if (products.length === limit) console.log(`\n  (tope de ${limit}; usá --limit=N para ver más)`)
}

async function cmdMissing(args: string[]) {
  const { flags } = parseFlags(args)
  const limit = Number(flags.limit ?? 50)
  const where = {
    isAssembly: false,
    OR: [
      { weightGrams: null }, { dimL: null }, { dimA: null }, { dimH: null },
    ],
  }

  const [total, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      select: { bajajCode: true, nameEs: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
      orderBy: { nameEs: 'asc' },
      take: limit,
    }),
  ])

  if (flags.json) return console.log(JSON.stringify(products, null, 2))
  table(
    ['SKU', 'Nombre', 'Falta'],
    products.map(p => {
      const falta = [
        p.weightGrams == null ? 'peso' : null,
        p.dimL == null || p.dimA == null || p.dimH == null ? 'medidas' : null,
      ].filter(Boolean).join(' + ')
      return [p.bajajCode ?? '—', p.nameEs.slice(0, 46), falta]
    }),
  )
  console.log(`\n  ${total} piezas incompletas en total${total > limit ? ` (mostrando ${limit})` : ''}.`)
}

// ── entrada ──────────────────────────────────────────────────────────────────
const USAGE = `
Consulta del catálogo — peso, medidas y volumen.

  pnpm q sku <SKU...>              ficha de uno o varios SKU
  pnpm q quote <SKU:qty>...        totales de una lista (peso, ft³, CBM, landed)
  pnpm q quote --file=<ruta|->     lo mismo desde JSON [{ sku, qty }] o stdin
  pnpm q search <texto>            buscar por nombre o SKU
  pnpm q missing                   piezas sin peso o sin medidas

Flags: --json  --limit=N  --inbound-china=USD  --china=SKU,SKU
`

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case 'sku':     return cmdSku(args)
    case 'quote':   return cmdQuote(args)
    case 'search':  return cmdSearch(args)
    case 'missing': return cmdMissing(args)
    default:        return console.log(USAGE)
  }
}

main()
  .catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
