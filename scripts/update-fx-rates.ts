// Lo corre cada hora el timer del servidor, bajaj-fx.timer (pnpm fx:update). Actualiza inr_usd_rate y
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

// Una tasa por fila de Config. Se escribe cada una que llegó bien: si una fuente se cae, las
// otras siguen al día (antes una sola caída dejaba las cuatro viejas hasta que volviera).
async function guardar(key: string, value: string, description: string) {
  await db.config.upsert({ where: { key }, update: { value }, create: { key, value, description } })
  console.log(`${key}=${value}`)
}

async function main() {
  const { inrUsd, bsdUsd, bcv, errores } = await fetchFxRates()

  if (inrUsd != null) {
    await guardar('inr_usd_rate', inrUsd.toFixed(2), 'Rupias indias por 1 USD — actualizado automáticamente cada hora (frankfurter.app)')
  }
  if (bsdUsd != null) {
    await guardar('bsd_usd_rate', bsdUsd.toFixed(2), 'BsD por 1 USD — actualizado automáticamente cada hora (promedio P2P Binance, alcambio.app)')
  }
  if (bcv) {
    await guardar('bcv_usd_rate', bcv.bcvUsd.toFixed(4), 'Bs oficiales BCV por 1 USD — actualizado automáticamente cada hora (usdt.com.ve)')
    await guardar('bcv_brecha_pct', bcv.brechaPct.toFixed(2), 'Brecha % del mejor precio paralelo sobre la tasa BCV — actualizado automáticamente cada hora (usdt.com.ve)')
  }
  // Lo que falló se reporta y marca la corrida como fallida (systemd lo ve), sin deshacer lo bueno.
  for (const e of errores) console.error(`tasa no actualizada: ${e}`)
  if (errores.length > 0) process.exitCode = 1

  // Que Shoppre se caiga no puede tumbar la actualización de tasas, que ya quedó
  // guardada arriba: se reporta el fallo y se sale con código ≠ 0 para que systemd lo
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
