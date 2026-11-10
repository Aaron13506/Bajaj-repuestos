import type { Prisma } from '@prisma/client'
import { db } from './db'
import type { BundlePiece } from './bundle'
import type { ConfigMap, EnvioItemInput, ReenvioCaja } from './calc'
import { expandCostPieces, lookupDeConjuntos } from './envio-build'
import { calcExpress, reenvioDelPresupuesto, viaDe, type Express } from './express'
import { ETAPAS_FUERA_DEL_DEPOSITO, reenvioDe } from './reenvio'

type Cliente = Prisma.TransactionClient | typeof db

const lineaSelect = {
  pedidoId: true, quantity: true, bundleItems: true,
  product: {
    select: { id: true, nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true },
  },
} satisfies Prisma.PedidoItemSelect

type Linea = Prisma.PedidoItemGetPayload<{ select: typeof lineaSelect }>

// Las líneas como piezas del paquete express (los conjuntos expandidos a sus piezas).
async function aPiezas(lineas: Linea[]): Promise<EnvioItemInput[]> {
  const lookup = await lookupDeConjuntos(lineas.map(it => it.bundleItems as BundlePiece[] | null))
  return lineas.flatMap(it =>
    expandCostPieces(it.product, it.quantity, it.bundleItems as BundlePiece[] | null, lookup).map(pz => ({
      pedidoId: it.pedidoId, productId: pz.productId, name: pz.name, weightGrams: pz.weightGrams,
      dimL: pz.dimL, dimA: pz.dimA, dimH: pz.dimH, priceInr: pz.priceInr, quantity: pz.quantity,
      origen: 'india' as const, inbound: 'shoppre' as const, supplierId: null,
    })),
  )
}

/**
 * Lo que ya va en una caja express, menos el presupuesto que se está costeando: viaja en el
 * mismo paquete, así que el flete se reparte con eso (ver ExpressOptions.acompanantes). Y su
 * reenvío: por kilo = express por USA, con la tarifa ₹/kg y el reempaque anotados en la caja.
 * shortcut: suma las piezas aunque la caja ya esté pesada o facturada; si hace falta, usar el costeo de la caja.
 */
export async function cajaExpress(
  tx: Cliente, envioId: number, sinPedidoId: number | null,
): Promise<{ acompanantes: EnvioItemInput[]; reenvio: ReenvioCaja | null }> {
  const [lineas, caja] = await Promise.all([
    tx.pedidoItem.findMany({
      where: {
        envioId,
        ...(sinPedidoId != null ? { pedidoId: { not: sinPedidoId } } : {}),
        pedido: { status: { not: 'cancelado' } },
      },
      select: lineaSelect,
    }),
    tx.envio.findUnique({ where: { id: envioId }, select: { reenvio: true, tarifaKgInr: true, reempaqueInr: true } }),
  ])
  const dec = (d: Prisma.Decimal | null) => (d != null ? Number(d) : null)
  return {
    acompanantes: await aPiezas(lineas),
    reenvio: caja ? { tipo: reenvioDe(caja.reenvio), tarifaKgInr: dec(caja.tarifaKgInr), reempaqueInr: dec(caja.reempaqueInr) } : null,
  }
}

// El paquete express de un presupuesto YA GUARDADO, tal como lo costea el armador: todas sus
// líneas en el paquete, junto con lo que ya va en su caja (o la elegida al cotizar). null si el presupuesto
// no es express. Lo usan la ficha (que muestra el tope y el margen) y aprobarPedido (que no deja
// confirmar un paquete pasado del tope). `tx` para leer las líneas dentro del cerrojo.
export async function expressDelPedido(
  tx: Cliente, pedidoId: number, cfg: ConfigMap,
): Promise<(Express & { cajaId: number | null; lineasEnCaja: boolean }) | null> {
  const p = await tx.pedido.findUnique({
    where: { id: pedidoId },
    select: { via: true, cajaExpressId: true, reenvio: true, tarifaKgInr: true, items: { select: { ...lineaSelect, envioId: true } } },
  })
  if (!p || viaDe(p.via) !== 'express') return null

  // La caja donde ya están sus líneas, o la elegida al cotizar (un presupuesto de cliente sin confirmar).
  const enCaja = p.items.find(it => it.envioId != null)?.envioId ?? null
  const cajaId = enCaja ?? p.cajaExpressId
  const [items, caja] = await Promise.all([
    aPiezas(p.items),
    cajaId != null ? cajaExpress(tx, cajaId, pedidoId) : Promise.resolve(null),
  ])
  const reenvio = reenvioDelPresupuesto(p.reenvio, p.tarifaKgInr != null ? Number(p.tarifaKgInr) : null, caja?.reenvio ?? null)
  return { ...calcExpress(items, cfg, { acompanantes: caja?.acompanantes, reenvio }), cajaId, lineasEnCaja: enCaja != null }
}

/** Cajas express a las que todavía se les puede sumar un presupuesto: nada salió aún del depósito (ni a Caracas ni a Miami). */
export async function cajasExpressAbiertas(): Promise<{ id: number; nombre: string; reenvio: string }[]> {
  const cajas = await db.envio.findMany({
    where: {
      modo: 'express',
      estado: { not: 'entregado' },
      items: { none: { shippingStatus: { in: ETAPAS_FUERA_DEL_DEPOSITO } } },
    },
    select: { id: true, nombre: true, estado: true, reenvio: true },
    orderBy: { id: 'desc' },
  })
  return cajas.map(c => ({
    id: c.id,
    reenvio: c.reenvio,
    nombre: `${c.nombre?.trim() || `Caja #${c.id}`}${c.reenvio === 'por_kilo' ? ' · por USA, sin tope' : ' · directo'}${c.estado === 'borrador' ? ' (borrador)' : ''}`,
  }))
}
