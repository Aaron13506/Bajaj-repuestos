import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { plazoExpress, viaDe } from '@/lib/express'
import { getConfig } from '@/lib/config-db'
import PresupuestoBuilder from '@/components/PresupuestoBuilder'
import { updatePresupuesto } from '../../actions'
import { type BundlePiece } from '@/lib/bundle'
import { cabeceraDeLinea, nombreEnsamble } from '@/lib/linea-pedido'
import { posicionesParaArmador } from '@/lib/inventario'
import { permisoDeLinea, permisoSinCliente } from '@/lib/pedido-edicion'

export default async function EditPresupuestoPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [presupuesto, assemblies, clientes, posiciones] = await Promise.all([
    db.pedido.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, nameEs: true, bajajCode: true, imageUrl: true,
                compatibleModels: true, discontinuedAt: true,
              },
            },
            ensamble: { select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true } },
            // Lo que el proveedor no tiene: el armador marca la pieza para que se vea cuál quitar.
            incidencias: { where: { estado: 'abierta', tipo: 'no_disponible' }, select: { pieza: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    }),
    // Solo headers de ensamble; los componentes se cargan on-demand al seleccionar uno.
    db.ensamble.findMany({
      select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true },
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
    }),
    db.cliente.findMany({
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, telefono: true },
    }),
    // Lo que ya tengo o ya viene de cada pieza. Si este mismo pedido propio está en una caja,
    // sus piezas cuentan ahí: es lo que ya viene.
    posicionesParaArmador(),
  ])

  // Editable si sigue siendo presupuesto, si es stock propio (nace como pedido pero es mío, así
  // que puedo ajustarlo) o si es un pedido de cliente confirmado — ese con límites según cuánto
  // haya avanzado cada línea (lib/pedido-edicion.ts). Uno cancelado o una venta no se edita.
  const confirmado = !!presupuesto && presupuesto.tipo === 'cliente' && presupuesto.status === 'pedido'
  const editable = presupuesto && (presupuesto.status === 'presupuesto' || presupuesto.tipo === 'propio' || confirmado)
  if (!presupuesto || !editable) notFound()

  const initialItems = presupuesto.items.map(item => {
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
      // Se pudo marcar DESPUÉS de cotizarla: el armador la muestra tachada en vez de
      // dejar que parezca normal hasta que el servidor rechace el guardado. Un conjunto no
      // se descontinúa (lo hacen sus piezas).
      descontinuada: item.product?.discontinuedAt != null,
      bundleItems: (item.bundleItems as BundlePiece[] | null) ?? undefined,
      noDisponibles: confirmado ? item.incidencias.flatMap(i => (i.pieza ? [i.pieza] : [])) : undefined,
      lineaNoDisponible: confirmado && item.incidencias.some(i => !i.pieza),
      // En un pedido confirmado, lo que esta línea admite según esté sin comprar, comprada o entregada.
      // En un propio o un presupuesto, lo ya comprado queda fijo salvo el precio (permisoSinCliente).
      restriccion: (confirmado ? permisoDeLinea : permisoSinCliente)({
        shippingStatus: item.shippingStatus,
        costRealUsd: item.costRealUsd != null ? Number(item.costRealUsd) : null,
        quantity: item.quantity,
        desdeStock: item.desdeStock,
      }),
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
        <div className="flex items-center gap-2 mb-1">
          <Link href={`/presupuestos/${id}`} className="text-gray-400 hover:text-gray-600 text-sm">
            Presupuesto #{id}
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-600">Editar</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">
          {presupuesto.tipo === 'propio' ? 'Editar stock propio' : confirmado ? 'Editar pedido' : 'Editar presupuesto'} — {presupuesto.clientName}
        </h1>
        {confirmado && (
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            El pedido ya está confirmado: lo que no se compró se cambia libremente; lo ya comprado admite otro precio o menos unidades
            (las de más pasan a stock propio con su costo); lo entregado no se toca. Todo queda en el historial del pedido.
          </p>
        )}
      </div>

      <PresupuestoBuilder
        assemblies={assembliesForClient}
        action={updatePresupuesto.bind(null, id)}
        tipo={presupuesto.tipo === 'propio' ? 'propio' : 'cliente'}
        initialClientName={presupuesto.clientName}
        initialClienteId={presupuesto.clienteId}
        clienteFijo={confirmado}
        initialNotas={presupuesto.notas ?? ''}
        initialItems={initialItems}
        clientes={clientes}
        posiciones={posiciones}
        initialVia={viaDe(presupuesto.via)}
        plazoExpressTexto={plazoExpress(await getConfig())}
      />
    </div>
  )
}
