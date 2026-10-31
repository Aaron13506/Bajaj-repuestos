import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import { cabeceraDeLinea, nombreEnsamble } from '@/lib/linea-pedido'
import { type BundlePiece } from '@/lib/bundle'
import Link from 'next/link'
import { viaDe } from '@/lib/express'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { createPresupuesto } from '../actions'
import { posicionesParaArmador } from '@/lib/inventario'

export const metadata = { title: 'Nuevo presupuesto' }

export default async function NewPresupuestoPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string; cliente?: string; desde?: string; via?: string }>
}) {
  const sp = await searchParams
  const desdeId = parseInt(sp.desde ?? '')

  // Solo headers de ensamble; los componentes se cargan on-demand al seleccionar uno.
  const [assemblies, clientes, posiciones, desde] = await Promise.all([
    db.ensamble.findMany({
      select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true },
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
    }),
    db.cliente.findMany({
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, telefono: true },
    }),
    // Lo que ya tengo o ya viene de cada pieza, para verlo mientras se arma.
    posicionesParaArmador(),
    // Duplicar: las líneas de otro presupuesto como punto de partida de uno nuevo.
    isNaN(desdeId) ? null : db.pedido.findUnique({
      where: { id: desdeId },
      select: {
        tipo: true, clientName: true, clienteId: true, via: true,
        items: {
          include: {
            product: { select: { id: true, nameEs: true, bajajCode: true, imageUrl: true, compatibleModels: true, discontinuedAt: true } },
            ensamble: { select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    }),
  ])
  const tipo = (desde?.tipo ?? sp.tipo) === 'propio' ? 'propio' : 'cliente'
  const clienteId = desde?.clienteId ?? (parseInt(sp.cliente ?? '') || null)

  // Mismos precios que el original, fijados: el armador muestra el sugerido de hoy al lado para decidir.
  const initialItems = (desde?.items ?? []).map(item => {
    const cab = cabeceraDeLinea(item)
    return {
      productId: item.productId,
      ensambleId: item.ensambleId,
      nameEs: cab.nameEs,
      bajajCode: cab.bajajCode,
      unitPrice: parseFloat(item.salePrice.toString()),
      quantity: item.quantity,
      imageUrl: cab.imageUrl,
      models: toModelIds(cab.compatibleModels),
      descontinuada: item.product?.discontinuedAt != null,
      bundleItems: (item.bundleItems as BundlePiece[] | null) ?? undefined,
    }
  })

  const assembliesForClient = assemblies.map(a => ({
    id: a.id,
    nameEs: nombreEnsamble(a),
    imageUrl: a.imageUrl,
    models: toModelIds(a.compatibleModels),
  }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {tipo === 'propio' ? 'Nuevo stock propio' : 'Nuevo presupuesto'}
        </h1>
        {desde && (
          <p className="text-sm text-gray-500 mt-1">
            Copia de <Link href={`/presupuestos/${desdeId}`} className="text-blue-600 hover:underline">#{desdeId}</Link>{' '}
            ({desde.clientName}), con sus precios. Revisalos contra el sugerido de hoy antes de guardar.
          </p>
        )}
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
        initialClientName={tipo === 'propio' ? (desde?.clientName ?? 'Stock propio') : ''}
        initialClienteId={clienteId}
        initialItems={initialItems}
        editando={false}
        clientes={clientes}
        posiciones={posiciones}
        // Un duplicado sale por la misma vía que el original; si no, la que pida el enlace.
        initialVia={viaDe(desde?.via ?? sp.via)}
      />
    </div>
  )
}
