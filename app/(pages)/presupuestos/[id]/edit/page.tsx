import { db } from '@/lib/db'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { sortModels } from '@/lib/catalog'
import { modelosDistintos } from '@/lib/modelos'
import { updatePresupuesto } from '../../actions'
import { type BundlePiece } from '@/lib/bundle'

export default async function EditPresupuestoPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [presupuesto, assemblies, clientes] = await Promise.all([
    db.pedido.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: { select: { id: true, nameEs: true, bajajCode: true, imageUrl: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    }),
    // Solo headers de ensamble; los componentes se cargan on-demand al seleccionar uno.
    db.product.findMany({
      where: { isAssembly: true },
      select: { id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true, compatibleModels: true },
      orderBy: { nameEs: 'asc' },
    }),
    db.cliente.findMany({
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, telefono: true },
    }),
  ])

  // Editable si sigue siendo presupuesto, o si es stock propio (nace como pedido
  // pero es mío, así que puedo ajustarlo). Un pedido de cliente confirmado no se edita.
  const editable = presupuesto && (presupuesto.status === 'presupuesto' || presupuesto.tipo === 'propio')
  if (!presupuesto || !editable) notFound()

  const initialItems = presupuesto.items.map(item => ({
    productId: item.productId,
    nameEs: item.product.nameEs,
    bajajCode: item.product.bajajCode,
    unitPrice: parseFloat(item.salePrice.toString()),
    quantity: item.quantity,
    imageUrl: item.product.imageUrl,
    bundleItems: (item.bundleItems as BundlePiece[] | null) ?? undefined,
  }))

  const models = sortModels(modelosDistintos(assemblies.map(a => a.compatibleModels)))

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
        <div className="flex items-center gap-2 mb-1">
          <Link href={`/presupuestos/${id}`} className="text-gray-400 hover:text-gray-600 text-sm">
            Presupuesto #{id}
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-600">Editar</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">
          {presupuesto.tipo === 'propio' ? 'Editar stock propio' : 'Editar presupuesto'} — {presupuesto.clientName}
        </h1>
      </div>

      <PresupuestoBuilder
        assemblies={assembliesForClient}
        models={models}
        action={updatePresupuesto.bind(null, id)}
        tipo={presupuesto.tipo === 'propio' ? 'propio' : 'cliente'}
        initialClientName={presupuesto.clientName}
        initialClienteId={presupuesto.clienteId}
        initialNotas={presupuesto.notas ?? ''}
        initialItems={initialItems}
        clientes={clientes}
      />
    </div>
  )
}
