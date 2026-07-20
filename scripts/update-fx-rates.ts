// Invocado por Heroku Scheduler cada hora (pnpm fx:update). Actualiza inr_usd_rate y
// bsd_usd_rate en Config con tasas frescas, para que calcLanded/calcEnvio siempre usen
// el valor del día sin intervención manual en /config.
import { PrismaClient } from '@prisma/client'
import { fetchFxRates } from '@/lib/fx-rates'

const db = new PrismaClient()

async function main() {
  const { inrUsd, bsdUsd } = await fetchFxRates()

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

  console.log(`inr_usd_rate=${inrUsd.toFixed(2)} bsd_usd_rate=${bsdUsd.toFixed(2)}`)
}

main()
  .catch(err => {
    console.error('update-fx-rates falló:', err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
