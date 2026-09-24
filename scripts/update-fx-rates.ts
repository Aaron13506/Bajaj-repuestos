// Invocado por Heroku Scheduler cada hora (pnpm fx:update). Actualiza inr_usd_rate y
// bsd_usd_rate en Config con tasas frescas, para que calcLanded/calcEnvio siempre usen
// el valor del día sin intervención manual en /config.
//
// De paso refresca las tarifas de flete de Shoppre (Config.shoppre_rates_usd). Van
// juntas porque son la misma clase de dato — precios externos que la app no controla —
// pero a distinta cadencia: la tasa cambia cada hora, el flete cada semanas, así que
// updateShippingRates se autolimita a una corrida diaria (ver su ventana de frescura).
import { PrismaClient } from '@prisma/client'
import { fetchFxRates } from '@/lib/fx-rates'
import { updateShippingRates } from './update-shipping-rates'

const db = new PrismaClient()

async function main() {
  const { inrUsd, bsdUsd, bcvUsd, brechaPct } = await fetchFxRates()

  await db.config.upsert({
    where: { key: 'inr_usd_rate' },
    update: { value: inrUsd.toFixed(2) },
    create: {
      key: 'inr_usd_rate',
      value: inrUsd.toFixed(2),
      description: 'Rupias indias por 1 USD — actualizado automáticamente cada hora (frankfurter.app)',
    },
  })

  await db.config.upsert({
    where: { key: 'bsd_usd_rate' },
    update: { value: bsdUsd.toFixed(2) },
    create: {
      key: 'bsd_usd_rate',
      value: bsdUsd.toFixed(2),
      description: 'BsD por 1 USD — actualizado automáticamente cada hora (promedio P2P Binance, alcambio.app)',
    },
  })

  await db.config.upsert({
    where: { key: 'bcv_usd_rate' },
    update: { value: bcvUsd.toFixed(4) },
    create: {
      key: 'bcv_usd_rate',
      value: bcvUsd.toFixed(4),
      description: 'Bs oficiales BCV por 1 USD — actualizado automáticamente cada hora (usdt.com.ve)',
    },
  })

  await db.config.upsert({
    where: { key: 'bcv_brecha_pct' },
    update: { value: brechaPct.toFixed(2) },
    create: {
      key: 'bcv_brecha_pct',
      value: brechaPct.toFixed(2),
      description: 'Brecha % del mejor precio paralelo sobre la tasa BCV — actualizado automáticamente cada hora (usdt.com.ve)',
    },
  })

  console.log(`inr_usd_rate=${inrUsd.toFixed(2)} bsd_usd_rate=${bsdUsd.toFixed(2)} bcv_usd_rate=${bcvUsd.toFixed(4)} bcv_brecha_pct=${brechaPct.toFixed(2)}`)

  // Que Shoppre se caiga no puede tumbar la actualización de tasas, que ya quedó
  // guardada arriba: se reporta el fallo y se sale con código ≠ 0 para que Heroku lo
  // marque, pero sin revertir lo bueno.
  try {
    const res = await updateShippingRates(db, { force: process.argv.includes('--force-rates') })
    console.log(res.skipped ? `shoppre_rates_usd: omitido (${res.reason})` : `shoppre_rates_usd: ${res.steps} escalones, ${res.changed} cambios`)
  } catch (err) {
    const e = err as Error & { failures?: string[] }
    console.error(`update-shipping-rates falló: ${e.message}`)
    for (const f of (e.failures ?? []).slice(0, 10)) console.error(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
  .catch(err => {
    console.error('update-fx-rates falló:', err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
