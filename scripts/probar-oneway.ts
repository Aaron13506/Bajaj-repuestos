// Prueba lib/oneway.ts contra la cuenta real, sin tocar la base: login, lista y detalle de un código.
//   pnpm tsx --env-file=.env scripts/probar-oneway.ts MT-112893
import { credencialesOneway, detalleOneway, entrarOneway, pedidosOneway } from '@/lib/oneway'

async function main() {
  const codigo = (process.argv[2] ?? 'MT-112893').toUpperCase()
  const cred = credencialesOneway()
  if (!cred) throw new Error('Faltan ONEWAY_EMAIL / ONEWAY_PASSWORD en el .env')
  const s = await entrarOneway(cred)
  const pedidos = await pedidosOneway(s)
  console.log('códigos en la cuenta:', [...pedidos.keys()].join(', '))
  const uuid = pedidos.get(codigo)
  if (!uuid) throw new Error(`${codigo} no está en la cuenta`)
  console.dir({ codigo, uuid, ...(await detalleOneway(s, uuid)) }, { depth: 3 })
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
