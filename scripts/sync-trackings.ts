// Lo corre cada hora el timer del servidor, bajaj-tracking.timer (pnpm tracking:sync): pone al
// día con Ship24 los trackings de las cajas que tienen courier y todavía no llegaron, y
// una vez por semana la lista de couriers para elegir. Ver lib/sync-trackings.ts.
//
//   pnpm tracking:sync                  la corrida normal
//   pnpm tracking:sync --couriers       además fuerza bajar la lista de couriers
//
// Sin SHIP24_API_KEY no hace nada y sale bien: el seguimiento está apagado, no roto.
import { apiKeyShip24, ENV_API_KEY } from '@/lib/ship24'
import { refrescarCouriers, sincronizarTrackings } from '@/lib/sync-trackings'
import { db } from '@/lib/db'

async function main() {
  const apiKey = apiKeyShip24()
  if (!apiKey) {
    console.log(`${ENV_API_KEY} no está definida: seguimiento automático apagado.`)
    return
  }
  try {
    const c = await refrescarCouriers(apiKey, { forzar: process.argv.includes('--couriers') })
    console.log(c.refrescada ? `couriers: ${c.total} (lista nueva)` : `couriers: ${c.total} (al día)`)
  } catch (e) {
    // Sin lista nueva se sigue con la vieja: no frena el seguimiento.
    console.error(`couriers no actualizados: ${(e as Error).message}`)
    process.exitCode = 1
  }
  const r = await sincronizarTrackings()
  console.log(`trackings: ${r.registrados} registrados, ${r.actualizados} actualizados, ${r.conError} con error`)
  if (r.error) {
    console.error(r.error)
    process.exitCode = 1
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
    // El pool de lib/db.ts (keepAlive, sin idle timeout) deja vivo el proceso: se sale a mano.
    process.exit(process.exitCode ?? 0)
  })
