import { db } from '../lib/db'
import { parseModelos, modelosDistintos } from '../lib/modelos'

async function main() {
  const asms = await db.product.findMany({
    where: { isAssembly: true },
    select: { id: true, nameEs: true, compatibleModels: true, _count: { select: { components: true } } },
  })
  console.log('ensambles:', asms.length)
  const modelos = modelosDistintos(asms.map(a => a.compatibleModels))
  console.log('modelos distintos:', modelos.length)
  console.log(modelos.sort().join(' | '))
  console.log('sin modelo:', asms.filter(a => parseModelos(a.compatibleModels).length === 0).length)
  console.log('sin componentes:', asms.filter(a => a._count.components === 0).length)

  const parts = await db.product.count({ where: { isAssembly: false } })
  const sinPrecio = await db.product.count({ where: { isAssembly: false, price: 0 } })
  const sinInr = await db.product.count({ where: { isAssembly: false, priceInr: null } })
  console.log({ parts, sinPrecio, sinInr })
}
main().finally(() => db.$disconnect())
