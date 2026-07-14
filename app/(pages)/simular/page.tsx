import { db } from '@/lib/db'
import SimuladorEnvio, { type SimProduct, type SimPedido } from '@/components/SimuladorEnvio'
import type { ConfigMap } from '@/lib/calc'
import { makeProductLookup, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'

export default async function SimularPage() {
  const [products, pedidos, cfgRows] = await Promise.all([
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
  ])

  const cfg = cfgRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})

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
      envioId: ped.envioId,
      saleTotal,
      pieceCount,
      costPieces,
    }
  })

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Simular envío</h1>
        <p className="text-sm text-gray-500 mt-1">
          Agregá los presupuestos que quieras (y piezas sueltas si hace falta) y mirá el costo
          aproximado del envío al instante.
        </p>
      </div>
      <SimuladorEnvio products={productsForClient} pedidos={pedidosForClient} cfg={cfg} />
    </div>
  )
}
