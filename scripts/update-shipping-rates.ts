// Refresca las tablas de tarifas de Shoppre y las deja en Config: India→USA
// (shoppre_rates_usd, la caja aérea) e India→Venezuela directo (shoppre_rates_ve_usd, el
// envío express). Es la misma API cambiando el país de destino.
//
// Lo invoca scripts/update-fx-rates.ts (pnpm fx:update, el timer horario del servidor).
// La copia viva va en Config, que es de donde ya salen todas las tarifas que lee
// calcLanded/calcEnvio; shipping_rates.json queda como el baseline que se buildea.
//
// CLI:
//   pnpm fx:update --force-rates scrapea aunque la tabla guardada sea reciente
//   pnpm rates:baseline          reescribe shipping_rates.json y shipping_rates_ve.json (los
//                                fallbacks del bundle)
import { PrismaClient } from '@prisma/client'
import { buildRateTable, CONFIG_KEY_TARIFAS, type DestinoTarifa, type RateTable, type ScrapedRates } from '@/lib/shipping-rates'

// El scraper es CommonJS sin tipos (viene tal cual del repo de análisis).
const { scrapeRates } = require('./shoppre-scraper') as {
  scrapeRates: (opts?: Record<string, unknown>) => Promise<ScrapedRates>
}

// Cómo se llama cada destino en la API de Shoppre (el `value` del selector de país de su
// calculadora), dónde queda su baseline y cómo se describe la fila de Config.
export const DESTINOS: Record<DestinoTarifa, { countryId: number; baseline: string; descripcion: string }> = {
  usa: {
    countryId: 226,
    baseline: 'shipping_rates.json',
    descripcion: 'Tarifas Shoppre India→USA en USD (escalones) — actualizado automáticamente a diario',
  },
  ve: {
    countryId: 231,
    baseline: 'shipping_rates_ve.json',
    descripcion: 'Tarifas Shoppre India→Venezuela directo (express) en USD (escalones) — actualizado automáticamente',
  },
}

// Rango que cubre la tabla: desde una pieza suelta hasta 22 kg, el tope de caja con el
// que se consolida. Paso 0.1 kg porque es la granularidad con la que Shoppre cambia de
// escalón.
export const SCRAPE_OPTIONS = { from: 0.5, to: 22, step: 0.1 }

// fx:update corre cada hora, pero las tarifas de flete se mueven cada semanas. Scrapear
// 216 pesos por hora serían ~5.200 requests diarios contra una API ajena y no
// documentada: se scrapea cada 3 días y el resto de las corridas no tocan Shoppre.
const MAX_AGE_HOURS = Number(process.env.SHOPPRE_RATES_MAX_AGE_H ?? 72)

// Hace cuánto se REVISÓ la tabla: `updatedAt` de la fila, que se toca en cada scrape aunque no
// haya cambios. No `generated_at`, que solo se mueve cuando cambian los precios: con él, tres
// días sin cambios de tarifa volvían a la tabla "vieja" para siempre y se scrapeaba cada hora.
function ageHours(revisadaAt: Date | undefined): number {
  if (!revisadaAt) return Infinity
  const ms = Date.now() - revisadaAt.getTime()
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

function summarize(destino: DestinoTarifa, diff: ReturnType<typeof diffTables>, limit = 8): string {
  const quien = `Shoppre ${destino.toUpperCase()}`
  if (diff.total === 0) return `${quien}: sin cambios de tarifa.`
  const lines = [`${quien}: ${diff.changed.length} escalones cambiaron, ${diff.added} nuevos, ${diff.removed} eliminados.`]
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
export async function updateShippingRates(
  db: PrismaClient,
  opts: { force?: boolean; destino?: DestinoTarifa } = {},
): Promise<UpdateResult> {
  const destino = opts.destino ?? 'usa'
  const CONFIG_KEY = CONFIG_KEY_TARIFAS[destino]
  const row = await db.config.findUnique({ where: { key: CONFIG_KEY } })
  const stored = readStored(row?.value)
  const age = stored ? ageHours(row?.updatedAt) : Infinity

  if (!opts.force && age < MAX_AGE_HOURS) {
    return { skipped: true, reason: `tabla de hace ${age.toFixed(1)} h (< ${MAX_AGE_HOURS} h)` }
  }

  const table = buildRateTable(await scrapeRates({ ...SCRAPE_OPTIONS, country: DESTINOS[destino].countryId }))
  const steps = Object.values(table.carriers).reduce((s, v) => s + v.length, 0)
  const diff = diffTables(stored, table)
  console.log(summarize(destino, diff))

  // Sin cambios no se reescribe la tabla (generated_at sigue marcando cuándo cambiaron los precios
  // de verdad), pero sí se anota que se revisó: es lo que frena el próximo scrape (ver ageHours).
  if (diff.total === 0 && stored) {
    await db.config.update({ where: { key: CONFIG_KEY }, data: { updatedAt: new Date() } })
    return { skipped: true, reason: 'sin cambios', steps, changed: 0 }
  }

  const value = JSON.stringify(table)
  await db.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value },
    create: {
      key: CONFIG_KEY,
      value,
      description: DESTINOS[destino].descripcion,
    },
  })
  return { skipped: false, steps, changed: diff.changed.length }
}

// ------------------------------------------------------------------ CLI

if (require.main === module) {
  const argv = process.argv.slice(2)

  // --destino=usa|ve limita la corrida a una tabla; sin él, las dos.
  const pedido = argv.find(a => a.startsWith('--destino='))?.split('=')[1]
  const destinos = (Object.keys(DESTINOS) as DestinoTarifa[]).filter(d => !pedido || d === pedido)
  if (destinos.length === 0) {
    console.error(`--destino desconocido: ${pedido} (usa | ve)`)
    process.exit(1)
  }

  const run = async () => {
    if (argv.includes('--baseline')) {
      // Regenera los fallbacks que se buildean en el bundle. Se corre en la PC y se commitea.
      const fs = await import('node:fs')
      const path = await import('node:path')
      for (const destino of destinos) {
        const { countryId, baseline } = DESTINOS[destino]
        const table = buildRateTable(await scrapeRates({
          ...SCRAPE_OPTIONS,
          country: countryId,
          onProgress: (d: number, t: number) => process.stderr.write(`\r  ${destino}: ${d}/${t} pesos`),
        }))
        process.stderr.write('\n')
        fs.writeFileSync(path.join(process.cwd(), baseline), JSON.stringify(table, null, 2) + '\n', 'utf8')
        const steps = Object.values(table.carriers).reduce((s, v) => s + v.length, 0)
        console.log(`${baseline}: ${Object.keys(table.carriers).length} carriers, ${steps} escalones`)
      }
      return
    }

    const db = new PrismaClient()
    try {
      for (const destino of destinos) {
        const res = await updateShippingRates(db, { force: argv.includes('--force'), destino })
        console.log(`${destino}: ${res.skipped ? `omitido (${res.reason})` : `guardado: ${res.steps} escalones, ${res.changed} cambios`}`)
      }
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