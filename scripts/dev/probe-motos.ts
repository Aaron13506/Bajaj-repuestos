import { db } from '../../lib/db'
import { parseModelos, modelosDistintos } from '../../lib/modelos'

async function main() {
  const asms = await db.ensamble.findMany({
    select: { id: true, nameEs: true, compatibleModels: true, _count: { select: { componentes: true } } },
  })
  console.log('ensambles:', asms.length)
  const modelos = modelosDistintos(asms.map(a => a.compatibleModels))
  console.log('modelos distintos:', modelos.length)
  console.log(modelos.sort().join(' | '))
  console.log('sin modelo:', asms.filter(a => parseModelos(a.compatibleModels).length === 0).length)
  console.log('sin componentes:', asms.filter(a => a._count.componentes === 0).length)

  const parts = await db.product.count()
  const sinPrecio = await db.product.count({ where: { price: 0 } })
  const sinInr = await db.product.count({ where: { priceInr: null } })
  console.log({ parts, sinPrecio, sinInr })
}
main().finally(() => db.$disconnect())
