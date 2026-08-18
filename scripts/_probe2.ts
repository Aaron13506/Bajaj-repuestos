import { db } from '../lib/db'
async function main() {
  const cfg = Object.fromEntries((await db.config.findMany()).map(c => [c.key, c.value]))
  console.log(cfg)
  const total = await db.product.count({ where: { isAssembly: false } })
  const conPeso = await db.product.count({ where: { isAssembly: false, weightGrams: { not: null } } })
  const conDim = await db.product.count({ where: { isAssembly: false, dimL: { not: null }, dimA: { not: null }, dimH: { not: null } } })
  const conMargen = await db.product.count({ where: { isAssembly: false, margin: { not: null } } })
  console.log({ total, conPeso, conDim, conMargen })
}
main().finally(() => db.$disconnect())
