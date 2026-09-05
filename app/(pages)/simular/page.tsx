import { db } from '@/lib/db'
import SimuladorEnvio, { type SimProduct, type SimPedido } from '@/components/SimuladorEnvio'
import CompararCompra, { type PedidoOpcion } from '@/components/CompararCompra'
import SimularTabs from '@/components/SimularTabs'
import type { ConfigMap } from '@/lib/calc'
import type { ProveedorOpcion } from '@/lib/comparar-compra'
import { makeProductLookup, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import { toConfigMap } from '@/lib/config'

export default async function SimularPage() {
  const [products, pedidos, cfgRows, suppliers] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: false },
      select: {
        id: true,
        nameEs: true,
        bajajCode: true,
        weightGrams: true,
        dimL: true,
        dimA: true,
        dimH: true,
        priceInr: true,
        price: true,
      },
      orderBy: { nameEs: 'asc' },
    }),
    db.pedido.findMany({
      include: {
        items: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.config.findMany(),
    // Los precios por pieza salen de SupplierPrice y se buscan al importar la lista; acá
    // solo hacen falta los ejes que definen cómo cotiza cada proveedor.
    db.supplier.findMany({
      select: { id: true, name: true, origen: true, inbound: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const cfg = toConfigMap(cfgRows)

  const proveedores: ProveedorOpcion[] = suppliers.map(s => ({
    id: s.id, nombre: s.name, origen: s.origen, inbound: s.inbound,
  }))

  // Lookup para resolver piezas de conjuntos a su producto real (por bajajCode).
  const lookup = makeProductLookup(products as ProductCost[])

  const productsForClient: SimProduct[] = products.map(p => ({
    id: p.id,
    nameEs: p.nameEs,
    bajajCode: p.bajajCode,
    weightGrams: p.weightGrams,
    dimL: p.dimL,
    dimA: p.dimA,
    dimH: p.dimH,
    priceInr: p.priceInr,
    price: parseFloat(p.price.toString()),
  }))

  const pedidosForClient: SimPedido[] = pedidos.map(ped => {
    let saleTotal = 0
    let pieceCount = 0
    const costPieces = ped.items.flatMap(it => {
      saleTotal += parseFloat(it.salePrice.toString()) * it.quantity
      pieceCount += it.quantity
      return expandCostPieces(
        it.product as ProductCost,
        it.quantity,
        it.bundleItems as BundlePiece[] | null,
        lookup,
      )
    })
    return {
      id: ped.id,
      clientName: ped.clientName,
      status: ped.status,
      // Un presupuesto puede estar repartido entre varias cajas: sus ítems se asignan
      // por separado. Se listan los envíos donde ya cayó alguna de sus piezas.
      envioIds: [...new Set(ped.items.map(it => it.envioId).filter((id): id is number => id != null))],
      saleTotal,
      pieceCount,
      costPieces,
    }
  })

  // El selector de presupuestos solo necesita el rótulo: al elegir uno, el server action
  // `cargarPedido` resuelve sus piezas y trae los precios de todos los proveedores. Mandar
  // acá las piezas de TODOS los presupuestos sería un payload enorme para usar uno.
  const pedidosParaComparar: PedidoOpcion[] = pedidosForClient.map(p => ({
    id: p.id,
    clientName: p.clientName,
    status: p.status,
    pieceCount: p.pieceCount,
    saleTotal: p.saleTotal,
  }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Simular envío</h1>
        <p className="text-sm text-gray-500 mt-1">
          Dos preguntas sobre una caja que todavía no existe: a quién comprarle, y por dónde traerla.
          Nada de lo que se toca acá se guarda.
        </p>
      </div>
      <SimularTabs
        compra={<CompararCompra proveedores={proveedores} pedidos={pedidosParaComparar} cfg={cfg} />}
        ruta={<SimuladorEnvio products={productsForClient} pedidos={pedidosForClient} cfg={cfg} />}
      />
    </div>
  )
}
