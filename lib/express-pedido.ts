import type { Prisma } from '@prisma/client'
import { db } from './db'
import type { BundlePiece } from './bundle'
import type { ConfigMap, EnvioItemInput } from './calc'
import { expandCostPieces, lookupDeConjuntos } from './envio-build'
import { calcExpress, viaDe, type Express } from './express'

type Cliente = Prisma.TransactionClient | typeof db

// El paquete express de un presupuesto YA GUARDADO, tal como lo costea el armador: todas sus
// líneas (los conjuntos expandidos a sus piezas) en un solo paquete. null si el presupuesto no
// es express. Lo usan la ficha (que muestra el tope y el margen) y aprobarPedido (que no deja
// confirmar un paquete pasado del tope). `tx` para leer las líneas dentro del cerrojo.
export async function expressDelPedido(tx: Cliente, pedidoId: number, cfg: ConfigMap): Promise<Express | null> {
  const p = await tx.pedido.findUnique({
    where: { id: pedidoId },
    select: {
      via: true,
      items: {
        select: {
          quantity: true, bundleItems: true,
          product: {
            select: { id: true, nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true },
          },
        },
      },
    },
  })
  if (!p || viaDe(p.via) !== 'express') return null

  const lookup = await lookupDeConjuntos(p.items.map(it => it.bundleItems as BundlePiece[] | null))
  const items: EnvioItemInput[] = p.items.flatMap(it =>
    expandCostPieces(it.product, it.quantity, it.bundleItems as BundlePiece[] | null, lookup).map(pz => ({
      pedidoId, productId: pz.productId, name: pz.name, weightGrams: pz.weightGrams,
      dimL: pz.dimL, dimA: pz.dimA, dimH: pz.dimH, priceInr: pz.priceInr, quantity: pz.quantity,
      origen: 'india' as const, inbound: 'shoppre' as const, supplierId: null,
    })),
  )
  return calcExpress(items, cfg)
}
