import { db } from '@/lib/db'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { sortModels } from '@/lib/catalog'
import { createPresupuesto } from '../actions'

export default async function NewPresupuestoPage() {
  // Solo headers de ensamble; los componentes se cargan on-demand al seleccionar uno.
  const assemblies = await db.product.findMany({
    where: { isAssembly: true },
    select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, compatibleModels: true },
    orderBy: { nameEs: 'asc' },
  })

  const models = sortModels(
    Array.from(new Set(assemblies.map(a => a.compatibleModels).filter((m): m is string => !!m)))
  )

  const assembliesForClient = assemblies.map(a => ({
    id: a.id,
    nameEs: a.nameEs,
    bajajCode: a.bajajCode,
    price: parseFloat(a.price.toString()),
    imageUrl: a.imageUrl,
    compatibleModels: a.compatibleModels,
  }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Nuevo presupuesto</h1>
      </div>
      <PresupuestoBuilder
        assemblies={assembliesForClient}
        models={models}
        action={createPresupuesto}
      />
    </div>
  )
}
