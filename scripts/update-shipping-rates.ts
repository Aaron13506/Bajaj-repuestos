// Refresca la tabla de tarifas Shoppre India→USA y la deja en Config.shoppre_rates_usd.
//
// Lo invoca scripts/update-fx-rates.ts (el cron horario de Heroku). El filesystem del
// dyno es efímero, así que la tabla NO puede vivir en shipping_rates.json en producción:
// ese archivo queda como el baseline que se buildea, y la copia viva va en Config, que
// es de donde ya salen todas las tarifas que lee calcLanded/calcEnvio.
//
// CLI:
//   pnpm rates:update            actualiza Config (respeta la ventana de frescura)
//   pnpm rates:update --force    scrapea aunque la tabla guardada sea reciente
//   pnpm rates:baseline          reescribe shipping_rates.json (el fallback del bundle)
import { PrismaClient } from '@prisma/client'
import { buildRateTable, type RateTable, type ScrapedRates } from '@/lib/shipping-rates'

// El scraper es CommonJS sin tipos (viene tal cual del repo de análisis, ver HEROKU-CRON.md).
const { scrapeRates } = require('./shoppre-scraper') as {
  scrapeRates: (opts?: Record<string, unknown>) => Promise<ScrapedRates>
}

export const CONFIG_KEY = 'shoppre_rates_usd'

// Rango que cubre la tabla: desde una pieza suelta hasta 22 kg, el tope de caja con el
// que se consolida. Paso 0.1 kg porque es la granularidad con la que Shoppre cambia de
// escalón.
export const SCRAPE_OPTIONS = { from: 0.5, to: 22, step: 0.1 }

// fx:update corre cada hora, pero las tarifas de flete se mueven cada semanas. Scrapear
// 216 pesos por hora serían ~5.200 requests diarios contra una API ajena y no
// documentada: se scrapea cada 3 días y el resto de las corridas no tocan Shoppre.
const MAX_AGE_HOURS = Number(process.env.SHOPPRE_RATES_MAX_AGE_H ?? 72)

function ageHours(table: RateTable | null): number {
  if (!table?.generated_at) return Infinity
  const ms = Date.now() - new Date(table.generated_at).getTime()
  return Number.isFinite(ms) ? ms / 3_600_000 : Infinity
}

function readStored(raw: string | undefined): RateTable | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as RateTable
  } catch {
    return null
  }
}

/** Compara dos tablas escalón y devuelve los tramos cuyo precio cambió. */
function diffTables(prev: RateTable | null, next: RateTable) {
  const flat = (t: RateTable | null) => {
    const m = new Map<string, number>()
    for (const [carrier, steps] of Object.entries(t?.carriers ?? {})) {
      for (const [maxKg, usd] of steps) m.set(`${carrier}|${maxKg}`, usd)
    }
    return m
  }
  const a = flat(prev)
  const b = flat(next)
  const changed: Array<{ key: string; from: number; to: number }> = []
  let added = 0
  for (const [k, v] of b) {
    if (!a.has(k)) added++
    else if (a.get(k) !== v) changed.push({ key: k, from: a.get(k)!, to: v })
  }
  let removed = 0
  for (const k of a.keys()) if (!b.has(k)) removed++
  return { changed, added, removed, total: changed.length + added + removed }
}

function summarize(diff: ReturnType<typeof diffTables>, limit = 8): string {
  if (diff.total === 0) return 'Shoppre: sin cambios de tarifa.'
  const lines = [`Shoppre: ${diff.changed.length} escalones cambiaron, ${diff.added} nuevos, ${diff.removed} eliminados.`]
  const worst = [...diff.changed]
    .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from))
    .slice(0, limit)
  for (const c of worst) {
    const [carrier, kg] = c.key.split('|')
    const pct = c.from ? ((c.to - c.from) / c.from) * 100 : 0
    lines.push(`  ≤${kg} kg  ${carrier}: $${c.from} → $${c.to} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`)
  }
  if (diff.changed.length > worst.length) lines.push(`  … y ${diff.changed.length - worst.length} más`)
  return lines.join('\n')
}

export interface UpdateResult {
  skipped: boolean
  reason?: string
  steps?: number
  changed?: number
}

/**
 * Scrapea y guarda si hace falta. Lanza si el scrape falla: scrapeRates() nunca
 * devuelve datos parciales, y una tabla incompleta no se distingue de una baja de
 * precio (corrompería el costeo en silencio).
 */
export async function updateShippingRates(db: PrismaClient, opts: { force?: boolean } = {}): Promise<UpdateResult> {
  const row = await db.config.findUnique({ where: { key: CONFIG_KEY } })
  const stored = readStored(row?.value)
  const age = ageHours(stored)

  if (!opts.force && age < MAX_AGE_HOURS) {
    return { skipped: true, reason: `tabla de hace ${age.toFixed(1)} h (< ${MAX_AGE_HOURS} h)` }
  }

  const table = buildRateTable(await scrapeRates(SCRAPE_OPTIONS))
  const steps = Object.values(table.carriers).reduce((s, v) => s + v.length, 0)
  const diff = diffTables(stored, table)
  console.log(summarize(diff))

  // Sin cambios no se reescribe la fila: así generated_at sigue marcando cuándo
  // cambiaron los precios de verdad, no cuándo corrió el cron por última vez.
  if (diff.total === 0 && stored) return { skipped: true, reason: 'sin cambios', steps, changed: 0 }

  const value = JSON.stringify(table)
  await db.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value },
    create: {
      key: CONFIG_KEY,
      value,
      description: 'Tarifas Shoppre India→USA en USD (escalones) — actualizado automáticamente a diario',
    },
  })
  return { skipped: false, steps, changed: diff.changed.length }
}

// ------------------------------------------------------------------ CLI

if (require.main === module) {
  const argv = process.argv.slice(2)

  const run = async () => {
    if (argv.includes('--baseline')) {
      // Regenera el fallback que se buildea en el bundle. Solo local: en Heroku el
      // archivo se pierde con el dyno.
      const fs = await import('node:fs')
      const path = await import('node:path')
      const table = buildRateTable(await scrapeRates({
        ...SCRAPE_OPTIONS,
        onProgress: (d: number, t: number) => process.stderr.write(`\r  ${d}/${t} pesos`),
      }))
      process.stderr.write('\n')
      const out = path.join(process.cwd(), 'shipping_rates.json')
      fs.writeFileSync(out, JSON.stringify(table, null, 2) + '\n', 'utf8')
      const steps = Object.values(table.carriers).reduce((s, v) => s + v.length, 0)
      console.log(`shipping_rates.json: ${Object.keys(table.carriers).length} carriers, ${steps} escalones`)
      return
    }

    const db = new PrismaClient()
    try {
      const res = await updateShippingRates(db, { force: argv.includes('--force') })
      console.log(res.skipped ? `omitido (${res.reason})` : `guardado: ${res.steps} escalones, ${res.changed} cambios`)
    } finally {
      await db.$disconnect()
    }
  }

  run().catch((err: Error & { failures?: string[] }) => {
    console.error(`update-shipping-rates falló: ${err.message}`)
    for (const f of err.failures ?? []) console.error(`  - ${f}`)
    process.exit(1)
  })
}