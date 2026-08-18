import { db } from '@/lib/db'
import Link from 'next/link'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { createPresupuesto } from '../actions'

export default async function NewPresupuestoPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string }>
}) {
  const sp = await searchParams
  const tipo = sp.tipo === 'propio' ? 'propio' : 'cliente'

  // Solo headers de ensamble; los componentes se cargan on-demand al seleccionar uno.
  const [assemblies, clientes] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: true },
      select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, models: true },
      orderBy: { nameEs: 'asc' },
    }),
    db.cliente.findMany({
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, telefono: true },
    }),
  ])

  const assembliesForClient = assemblies.map(a => ({
    id: a.id,
    nameEs: a.nameEs,
    bajajCode: a.bajajCode,
    price: parseFloat(a.price.toString()),
    imageUrl: a.imageUrl,
    models: a.models,
  }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {tipo === 'propio' ? 'Nuevo stock propio' : 'Nuevo presupuesto'}
        </h1>
        {tipo === 'propio' && (
          <p className="text-sm text-gray-500 mt-1">
            Piezas que traés para revender <span className="font-medium">por la ruta aérea</span>, junto con los
            pedidos de cliente. Para traer stock por barco usá un{' '}
            <Link href="/envios" className="text-blue-600 hover:underline">embarque marítimo</Link>, que se arma
            aparte y se costea por volumen.
          </p>
        )}
      </div>
      <PresupuestoBuilder
        assemblies={assembliesForClient}
        action={createPresupuesto}
        tipo={tipo}
        initialClientName={tipo === 'propio' ? 'Stock propio' : ''}
        clientes={clientes}
      />
    </div>
  )
}
