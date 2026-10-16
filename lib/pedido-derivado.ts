// Lo que se le hace a un pedido ya confirmado y toca la base: dejar constancia, pasar lo comprado
// a stock propio y mandar una reposición. Todo corre dentro de la transacción de quien lo llama.
//
// Las reglas de qué se puede hacer (cuándo una línea es "comprada", cómo se reparte el costo)
// son puras y viven en lib/pedido-edicion.ts y lib/incidencias.ts; acá solo se aplican.
import { Prisma } from '@prisma/client'
import { ErrorDeNegocio } from '@/lib/action-result'
import { claveLinea } from '@/lib/linea-pedido'
import { repartirSobrante } from '@/lib/pedido-edicion'

type Tx = Prisma.TransactionClient

const dec = (v: { toString(): string } | null | undefined) => (v != null ? parseFloat(v.toString()) : null)

// Una línea más en el historial del pedido. No se lee para calcular nada: es la memoria de por
// qué el pedido de hoy no es el que aceptó el cliente.
export async function registrarEvento(tx: Tx, pedidoId: number, tipo: string, detalle: string) {
  await tx.pedidoEvento.create({ data: { pedidoId, tipo, detalle } })
}

// Los campos de una línea que viajan con ella cuando pasa a otro pedido: dónde está, qué etapa y
// qué costó. Lo comercial (precio, cantidad) lo decide quien la mueve.
const LINEA_LOGISTICA = {
  id: true, productId: true, ensambleId: true, quantity: true, salePrice: true, bundleItems: true,
  envioId: true, shippingStatus: true, shippingStatusAt: true, supplierId: true, origen: true,
  inbound: true, isLanded: true, costRealUsd: true, compradoAt: true,
} as const

export type LineaMovible = Prisma.PedidoItemGetPayload<{ select: typeof LINEA_LOGISTICA }>
export const SELECT_LINEA_MOVIBLE = LINEA_LOGISTICA

// El pedido de stock propio que recibe lo que sobra de uno de cliente. Uno por pedido de origen:
// varias bajas de cantidad sobre el mismo pedido se juntan ahí en vez de abrir un pedido nuevo cada vez.
async function pedidoSobrante(tx: Tx, origen: { id: number; clientName: string }): Promise<number> {
  const existente = await tx.pedido.findFirst({
    where: { origenId: origen.id, origenMotivo: 'sobrante', tipo: 'propio' },
    select: { id: true },
  })
  if (existente) return existente.id
  const creado = await tx.pedido.create({
    data: {
      clientName: `Sobrante de #${origen.id} · ${origen.clientName}`,
      tipo: 'propio',
      status: 'pedido',
      origenId: origen.id,
      origenMotivo: 'sobrante',
      notas: `Piezas ya compradas para el pedido #${origen.id} que el cliente no se lleva. Pasaron a stock propio con su costo.`,
    },
    select: { id: true },
  })
  return creado.id
}

export interface Sobrante {
  linea: LineaMovible
  /** Unidades que pasan a stock propio. Todas las de la línea = la línea entera se muda. */
  unidades: number
}

// Pasa unidades de líneas YA COMPRADAS de un pedido de cliente a stock propio. El costo viaja con
// las unidades (prorrateado por cantidad, ver repartirSobrante) y también su caja y su etapa: la
// pieza sigue en camino en la misma caja, ahora para mí.
//
// Deja la línea de origen consistente: si se fue una parte baja su cantidad y su costo (el resto
// EXACTO, para que no se pierda ni sobre un centavo); si se fue entera, la línea se muda de pedido
// con su historia (etapas, incidencias) o, si ese pedido ya tenía la pieza, se junta con ella y la
// de origen se borra. Quien llama no tiene que tocar la línea de origen salvo para cambiarle el precio.
//
// Si el pedido de sobrante ya tiene esa pieza se suma, pero solo si viaja en la misma caja y en
// la misma etapa: mezclar dos situaciones distintas en una línea inventaría un estado que no existe.
export async function pasarAStockPropio(
  tx: Tx,
  origen: { id: number; clientName: string },
  sobrantes: Sobrante[],
): Promise<{ pedidoId: number }> {
  const pedidoId = await pedidoSobrante(tx, origen)

  for (const { linea, unidades } of sobrantes) {
    const costo = dec(linea.costRealUsd)
    const { sobranteUsd, quedaUsd } = repartirSobrante(costo, linea.quantity, unidades)
    const entera = unidades >= linea.quantity

    const clave = claveLinea(linea)
    const ya = (await tx.pedidoItem.findMany({
      where: { pedidoId },
      select: { id: true, productId: true, ensambleId: true, quantity: true, envioId: true, shippingStatus: true, costRealUsd: true },
    })).find(i => claveLinea(i) === clave)

    if (ya) {
      if (ya.envioId !== linea.envioId || ya.shippingStatus !== linea.shippingStatus) {
        throw new ErrorDeNegocio(
          'Ya hay un sobrante de esta pieza en otra caja o en otra etapa. Resolvelo primero (recibilo o movelo) y probá de nuevo.',
        )
      }
      const costoJunto = sobranteUsd == null && ya.costRealUsd == null ? null : (sobranteUsd ?? 0) + (dec(ya.costRealUsd) ?? 0)
      await tx.pedidoItem.update({
        where: { id: ya.id },
        data: { quantity: ya.quantity + unidades, costRealUsd: costoJunto },
      })
      if (entera) await tx.pedidoItem.delete({ where: { id: linea.id } })
      else await tx.pedidoItem.update({ where: { id: linea.id }, data: { quantity: linea.quantity - unidades, costRealUsd: quedaUsd } })
      continue
    }

    if (entera) {
      // La línea entera cambia de pedido: conserva su historia (etapas, incidencias) y su id.
      await tx.pedidoItem.update({ where: { id: linea.id }, data: { pedidoId } })
      continue
    }

    await tx.pedidoItem.create({
      data: {
        pedidoId,
        productId: linea.productId,
        ensambleId: linea.ensambleId,
        quantity: unidades,
        salePrice: linea.salePrice,
        bundleItems: linea.bundleItems ?? Prisma.DbNull,
        envioId: linea.envioId,
        shippingStatus: linea.shippingStatus,
        shippingStatusAt: linea.shippingStatusAt,
        supplierId: linea.supplierId,
        origen: linea.origen,
        inbound: linea.inbound,
        isLanded: linea.isLanded,
        costRealUsd: sobranteUsd,
        compradoAt: linea.compradoAt,
      },
    })
    await tx.pedidoItem.update({ where: { id: linea.id }, data: { quantity: linea.quantity - unidades, costRealUsd: quedaUsd } })
  }
  return { pedidoId }
}

// Un pedido nuevo, a $0, con unas unidades que hay que volver a mandar (una pieza que llegó mal).
// Es un pedido normal de cliente: se compra, viaja en una caja y se entrega como cualquiera, y lo
// que cuesta traerlo queda como margen negativo SUYO. No lleva adelanto ni saldo (no hay nada que
// cobrar) y no se presenta a BCV.
export async function crearReposicion(
  tx: Tx,
  origen: { id: number; clientName: string; clienteId: number | null },
  linea: { productId: number | null; ensambleId: number | null; bundleItems: unknown },
  unidades: number,
): Promise<number> {
  const creado = await tx.pedido.create({
    data: {
      clientName: origen.clientName,
      clienteId: origen.clienteId,
      tipo: 'cliente',
      status: 'pedido',
      origenId: origen.id,
      origenMotivo: 'reposicion',
      notas: `Reposición del pedido #${origen.id}: se vuelve a mandar sin costo para el cliente.`,
      items: {
        create: [{
          productId: linea.productId,
          ensambleId: linea.ensambleId,
          quantity: unidades,
          salePrice: 0,
          bundleItems: (linea.bundleItems as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        }],
      },
    },
    select: { id: true },
  })
  return creado.id
}
