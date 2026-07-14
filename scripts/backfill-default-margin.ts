/**
 * Backfill del margen por defecto a las piezas que quedaron con margin=null.
 * (La carga por JSON vieja calculaba el precio con el default pero no persistía el
 * campo margin; este script lo completa.)
 *
 * Alcance: Product con isAssembly=false, priceLocked=false, margin=null.
 *   - Todas → margin = default_margin_pct/100 (de Config).
 *   - Las que tienen INR + peso → además recalcula landedCostUsd y price (= landed/(1-margen)).
 * No toca ensambles ni piezas con precio fijo (priceLocked) ni las que ya tienen margen.
 *
 * Uso:
 *   pnpm exec tsx scripts/backfill-default-margin.ts            # DRY-RUN
 *   pnpm exec tsx scripts/backfill-default-margin.ts --apply    # ejecuta
 */
import { PrismaClient } from '@prisma/client'
import { calcLanded, type ConfigMap } from '@/lib/calc'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})
const APPLY = process.argv.includes('--apply')
const round2 = (n: number) => Math.round(n * 100) / 100

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => { while (i < items.length) await fn(items[i++]) }
  await Promise.all(Array.from({ length: n }, worker))
}

async function main() {
  console.log(APPLY ? '── MODO APPLY ──' : '── DRY-RUN ──')

  const cfgRows = await prisma.config.findMany()
  const cfg = cfgRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})
  const defaultMargin = parseFloat(cfg.default_margin_pct ?? '40') / 100
  console.log(`Margen por defecto (Config.default_margin_pct): ${(defaultMargin * 100).toFixed(2)}%`)

  const base = { isAssembly: false as const, priceLocked: false, margin: null }

  // Cuántas caen en total, y cuántas pueden recalcular precio (tienen INR + peso).
  const total = await prisma.product.count({ where: base })
  const computableWhere = { ...base, priceInr: { not: null }, weightGrams: { not: null } }
  const computableCount = await prisma.product.count({ where: computableWhere })
  const marginOnly = total - computableCount

  console.log(`Piezas sin margen (no fijas, no ensamble): ${total}`)
  console.log(`  · con INR+peso (recalculan precio): ${computableCount}`)
  console.log(`  · solo margen (sin costo aún):       ${marginOnly}`)

  if (!APPLY) {
    console.log('\nDRY-RUN: correr con --apply para ejecutar.')
    return
  }

  // Fase 1: las que no pueden calcular precio → solo setear margen (una sola query).
  const r1 = await prisma.product.updateMany({
    where: { ...base, OR: [{ priceInr: null }, { weightGrams: null }] },
    data: { margin: defaultMargin },
  })
  console.log(`\nFase 1: ${r1.count} piezas con margen seteado (sin recálculo de precio).`)

  // Fase 2: con INR+peso → margen + landed + precio, por fila (pool).
  const computable = await prisma.product.findMany({
    where: computableWhere,
    select: { id: true, priceInr: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
  })
  let priced = 0
  await pool(computable, 8, async (p) => {
    const b = calcLanded({ ...p, margin: defaultMargin }, cfg)
    const data: Record<string, unknown> = { margin: defaultMargin }
    if (b) {
      data.landedCostUsd = round2(b.landedCostUsd)
      if (b.priceUsd != null) { data.price = round2(b.priceUsd); priced++ }
    }
    await prisma.product.update({ where: { id: p.id }, data })
  })
  console.log(`Fase 2: ${computable.length} piezas actualizadas · ${priced} con precio recalculado.`)

  const remaining = await prisma.product.count({ where: base })
  console.log(`\n✓ Listo. Piezas sin margen restantes: ${remaining}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
