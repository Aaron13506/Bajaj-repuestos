/**
 * Llena Product.models (enum MotoModel[]) a partir del viejo Product.compatibleModels.
 *
 *   pnpm backfill:models            # dry-run: muestra qué haría, no escribe
 *   pnpm backfill:models --apply    # escribe
 *   pnpm backfill:models --apply --verbose
 *
 * Tres fuentes, en orden de confianza:
 *
 *   1. El texto guardado — sus entradas que SON uno de los 14 modelos. Es el dato
 *      curado y manda cuando existe.
 *   2. El catálogo scrapeado — los ScrapedProduct.model de las páginas donde aparece
 *      el SKU. Resuelve las filas cuyo texto es solo un alias ("N250" a secas).
 *   3. Expansión por familia — último recurso para los alias de piezas que no están
 *      en el scrape: "N250" ⇒ las 3 N250, "N250/N160" ⇒ esas 3 más las 2 N160.
 *
 * Es re-ejecutable: recalcula desde compatibleModels, no acumula.
 */
import { db } from '@/lib/db'
import { MOTO_MODELS, formatModels, modelByLabel, parseModels, type MotoModelId } from '@/lib/modelo'

const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')

// Alias de familia: lo que dice el texto libre → qué familias abarca. Solo se usa
// cuando el SKU no está en el scrape y el texto no trae ningún modelo canónico.
const FAMILY_ALIASES: { match: RegExp; families: string[] }[] = [
  { match: /N250.*N160|N160.*N250/i, families: ['N250', 'N160'] },
  { match: /\bN250\b/i,              families: ['N250'] },
  { match: /\bN160\b/i,              families: ['N160'] },
  { match: /\bNS200\b/i,             families: ['NS200'] },
  { match: /\b200NS\b/i,             families: ['200NS'] },
  { match: /\b180\b/i,               families: ['180'] },
  { match: /\b150\b/i,               families: ['150'] },
]

function expandFamilies(text: string): MotoModelId[] {
  for (const { match, families } of FAMILY_ALIASES) {
    if (match.test(text)) {
      return MOTO_MODELS.filter(m => families.includes(m.family)).map(m => m.id)
    }
  }
  return []
}

type Source = 'texto' | 'scrape' | 'familia' | 'vacío'

async function main() {
  const products = await db.product.findMany({
    select: { id: true, nameEs: true, bajajCode: true, isAssembly: true, compatibleModels: true },
    orderBy: { id: 'asc' },
  })

  // SKU → modelos, desde el scrape. Una sola query en vez de 5.342.
  const parts = await db.scrapedPart.findMany({
    select: { sku: true, group: { select: { product: { select: { model: true } } } } },
  })
  const scrapeBySku = new Map<string, Set<MotoModelId>>()
  for (const p of parts) {
    const set = scrapeBySku.get(p.sku) ?? new Set<MotoModelId>()
    set.add(p.group.product.model as MotoModelId)
    scrapeBySku.set(p.sku, set)
  }

  const counts: Record<Source, number> = { texto: 0, scrape: 0, familia: 0, 'vacío': 0 }
  const noResueltos: typeof products = []
  const porFamilia: { p: (typeof products)[number]; ids: MotoModelId[] }[] = []
  const batches = new Map<string, { ids: MotoModelId[]; productIds: number[] }>()
  let escritos = 0

  for (const p of products) {
    const raw = parseModels(p.compatibleModels)
    const desdeTexto = raw.map(modelByLabel).filter((m): m is NonNullable<typeof m> => m != null).map(m => m.id)

    let ids: MotoModelId[] = desdeTexto
    let source: Source = 'texto'
    if (ids.length === 0) {
      const desdeScrape = p.bajajCode ? scrapeBySku.get(p.bajajCode) : undefined
      if (desdeScrape?.size) {
        ids = [...desdeScrape]
        source = 'scrape'
      } else {
        ids = expandFamilies(p.compatibleModels ?? '')
        source = ids.length > 0 ? 'familia' : 'vacío'
      }
    }

    // Orden de catálogo, sin repetidos.
    const unique = MOTO_MODELS.filter(m => ids.includes(m.id)).map(m => m.id)

    counts[source]++
    if (source === 'familia') porFamilia.push({ p, ids: unique })
    if (source === 'vacío') noResueltos.push(p)

    if (VERBOSE || source !== 'texto') {
      const labels = unique.map(id => MOTO_MODELS.find(m => m.id === id)!.label)
      console.log(
        `  #${String(p.id).padEnd(5)} [${source.padEnd(7)}] ${(p.bajajCode ?? '—').padEnd(11)} ` +
        `${p.nameEs.slice(0, 26).padEnd(26)} → ${labels.length ? formatModels(labels) : '(sin modelos)'}`,
      )
    }

    // Se agrupa por conjunto de modelos: miles de piezas comparten el mismo, y un
    // updateMany por conjunto son ~cientos de round-trips en vez de 5.342.
    const key = unique.join('|')
    const batch = batches.get(key) ?? { ids: unique, productIds: [] as number[] }
    batch.productIds.push(p.id)
    batches.set(key, batch)
  }

  if (APPLY) {
    for (const { ids, productIds } of batches.values()) {
      const r = await db.product.updateMany({ where: { id: { in: productIds } }, data: { models: { set: ids } } })
      escritos += r.count
    }
  }

  console.log('\n── resumen ──')
  console.log(`  ${products.length} productos`)
  console.log(`   ${String(counts.texto).padStart(5)}  del texto canónico`)
  console.log(`   ${String(counts.scrape).padStart(5)}  resueltos por el scrape (SKU)`)
  console.log(`   ${String(counts.familia).padStart(5)}  expandidos por familia`)
  console.log(`   ${String(counts['vacío']).padStart(5)}  sin modelos — hay que cargarlos a mano`)

  if (porFamilia.length) {
    console.log('\n  expandidos por familia (revisar):')
    for (const { p } of porFamilia) console.log(`    #${p.id} ${p.nameEs} — texto: ${JSON.stringify(p.compatibleModels)}`)
  }
  if (noResueltos.length) {
    console.log('\n  sin modelos (cargar desde /products/[id]/edit):')
    for (const p of noResueltos) console.log(`    #${p.id} ${p.nameEs} — texto: ${JSON.stringify(p.compatibleModels)}`)
  }

  console.log(APPLY ? `\n✓ ${escritos} productos actualizados.` : '\n(dry-run — nada escrito. Correr con --apply.)')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
