import { db } from '../lib/db'
import { sortModels } from '../lib/modelo'

async function main() {
  const asms = await db.product.findMany({
    where: { isAssembly: true },
    select: { id: true, nameEs: true, models: true, _count: { select: { components: true } } },
  })
  console.log('ensambles:', asms.length)
  const modelos = sortModels([...new Set(asms.flatMap(a => a.models))])
  console.log('modelos distintos:', modelos.length)
  console.log(modelos.sort().join(' | '))
  console.log('sin modelo:', asms.filter(a => a.models.length === 0).length)
  console.log('sin componentes:', asms.filter(a => a._count.components === 0).length)

  const parts = await db.product.count({ where: { isAssembly: false } })
  const sinPrecio = await db.product.count({ where: { isAssembly: false, price: 0 } })
  const sinInr = await db.product.count({ where: { isAssembly: false, priceInr: null } })
  console.log({ parts, sinPrecio, sinInr })
}
main().finally(() => db.$disconnect())
