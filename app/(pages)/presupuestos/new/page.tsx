import { db } from '@/lib/db'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { sortModels } from '@/lib/catalog'
import { createPresupuesto } from '../actions'

export default async function NewPresupuestoPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string }>
}) {
  const tipo = (await searchParams).tipo === 'propio' ? 'propio' : 'cliente'

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
        <h1 className="text-2xl font-bold text-gray-900">
          {tipo === 'propio' ? 'Nuevo stock propio' : 'Nuevo presupuesto'}
        </h1>
        {tipo === 'propio' && (
          <p className="text-sm text-gray-500 mt-1">
            Piezas que traés para revender por tu cuenta. Suman al peso y volumen del envío, sin cliente ni adelanto.
          </p>
        )}
      </div>
      <PresupuestoBuilder
        assemblies={assembliesForClient}
        models={models}
        action={createPresupuesto}
        tipo={tipo}
        initialClientName={tipo === 'propio' ? 'Stock propio' : ''}
      />
    </div>
  )
}
