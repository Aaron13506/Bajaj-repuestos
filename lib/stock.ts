import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import { esStockNegativo } from '@/lib/prisma-errors'

// Kardex: el libro de stock (docs/plan-inventario/02-kardex.md). MovimientoStock es la verdad y
// Product.stock su caché, igual que Movimiento y Pedido.depositUsd. Este es el ÚNICO archivo que
// escribe Product.stock: cada escritura inserta su movimiento en la misma sentencia, así no hay
// uno sin el otro. Un movimiento no se edita ni se borra: un error se corrige con otro.

export const MOTIVOS_STOCK = [
  'saldo_inicial',      // migración
  'alta',               // pieza creada con stock
  'ajuste',             // corrección a mano, con nota obligatoria
  'recepcion',          // caja recibida (fase 3 la unifica para aéreo y marítimo)
  'reversa_recepcion',
  'entrega_propio',     // línea propia aérea que pasa a 'entregado' (hasta la fase 3)
  'reversa_entrega_propio',
  'edicion_pedido',     // editar lo entregado de un pedido propio
  'servido_pedido',     // servir una línea de cliente con lo del depósito
  'devuelto_deposito',  // deshacer lo anterior
  'venta',
  'anulacion_venta',
  'sobrante_recepcion', // fase 3
  'conteo',             // fase 5
] as const
export type MotivoStock = (typeof MOTIVOS_STOCK)[number]

// Signo que exige cada motivo: +1 entra, −1 sale, 0 cualquiera.
export const SIGNO_MOTIVO: Record<MotivoStock, 1 | -1 | 0> = {
  saldo_inicial: 0,
  alta: 1,
  ajuste: 0,
  recepcion: 1,
  reversa_recepcion: -1,
  entrega_propio: 1,
  reversa_entrega_propio: -1,
  edicion_pedido: 0,
  servido_pedido: -1,
  devuelto_deposito: 1,
  venta: -1,
  anulacion_venta: 1,
  sobrante_recepcion: 1,
  conteo: 0,
}

export const MOTIVO_STOCK_LABEL: Record<MotivoStock, string> = {
  saldo_inicial: 'Saldo inicial',
  alta: 'Alta',
  ajuste: 'Ajuste',
  recepcion: 'Recepción',
  reversa_recepcion: 'Recepción deshecha',
  entrega_propio: 'Llegó (propio)',
  reversa_entrega_propio: 'Llegada deshecha',
  edicion_pedido: 'Pedido editado',
  servido_pedido: 'Servido a pedido',
  devuelto_deposito: 'Vuelve al depósito',
  venta: 'Venta',
  anulacion_venta: 'Venta anulada',
  sobrante_recepcion: 'Sobrante',
  conteo: 'Conteo',
}

export interface MovStock {
  productId: number
  cantidad: number
  motivo: MotivoStock
  costoUnitUsd?: number | null
  nota?: string | null
  envioId?: number | null
  pedidoId?: number | null
  pedidoItemId?: number | null
  recepcionId?: number | null
}

// Lo que hace inválido un movimiento, o null. Pura: la usa moverStock y check:costeo.
export function motivoMovStockInvalido(m: MovStock): string | null {
  if (!MOTIVOS_STOCK.includes(m.motivo)) return `Motivo de stock desconocido: ${m.motivo}.`
  if (!Number.isInteger(m.cantidad) || m.cantidad === 0) return 'La cantidad tiene que ser un entero distinto de cero.'
  const signo = SIGNO_MOTIVO[m.motivo]
  if (signo !== 0 && Math.sign(m.cantidad) !== signo) {
    return `Un movimiento «${MOTIVO_STOCK_LABEL[m.motivo]}» tiene que ${signo > 0 ? 'sumar' : 'restar'}.`
  }
  if (m.motivo === 'ajuste' && !m.nota?.trim()) return 'Un ajuste de stock necesita una nota que diga por qué.'
  return null
}

// No alcanza el stock: la base rechazó dejar una pieza en negativo (Product_stock_no_negativo).
// `piezas` son sus códigos (o nombres), para que quien llama arme su propio mensaje.
export class StockInsuficiente extends ErrorDeNegocio {
  constructor(readonly piezas: string[]) {
    super(`No alcanza el stock de ${piezas.length > 0 ? piezas.join(', ') : 'una de las piezas'}.`)
  }
}

// El fragmento que inserta las filas de `filas` (un VALUES o un SELECT con las columnas de abajo,
// en ese orden) y suma su cantidad a Product.stock. Va al final de un WITH: quien lo usa escribe
// `WITH [sus CTEs,] ${sqlStockDesde(...)}`, y así el movimiento y la caché salen de la misma
// sentencia (lib/mover-etapas.ts lo engancha sobre las filas que de verdad se movieron).
export function sqlStockDesde(filas: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    ms AS (
      INSERT INTO "MovimientoStock"
        ("productId", "cantidad", "motivo", "costoUnitUsd", "nota", "envioId", "pedidoId", "pedidoItemId", "recepcionId", "grupo", "createdAt")
      SELECT f.*, (NOW() AT TIME ZONE 'UTC') FROM (${filas}) AS f
      RETURNING "productId", "cantidad"
    )
    UPDATE "Product" AS p
    SET "stock" = p."stock" + s.delta, "updatedAt" = NOW()
    FROM (SELECT "productId", SUM("cantidad")::int AS delta FROM ms GROUP BY 1) AS s
    WHERE p."id" = s."productId"`
}

// Corre `escribir` y, si la base rechaza un stock negativo, lo convierte en StockInsuficiente con
// las piezas de `deltas` (productId → cuánto se movía) que no alcanzan. La transacción de quien
// llama ya está abortada, así que se lee por fuera: es solo para el mensaje.
export async function conStockSuficiente<T>(deltas: Map<number, number>, escribir: () => Promise<T>): Promise<T> {
  try {
    return await escribir()
  } catch (e) {
    if (!esStockNegativo(e)) throw e
    const bajan = [...deltas].filter(([, d]) => d < 0).map(([id]) => id)
    const prods = await db.product.findMany({ where: { id: { in: bajan } }, select: { id: true, stock: true, nameEs: true, bajajCode: true } })
    throw new StockInsuficiente(prods.filter(p => p.stock + deltas.get(p.id)! < 0).map(p => p.bajajCode ?? p.nameEs))
  }
}

// La sentencia de un lote de movimientos: valida cada uno y los mete como VALUES.
function sqlMovs(movs: MovStock[], grupo?: string): Prisma.Sql {
  for (const m of movs) {
    const no = motivoMovStockInvalido(m)
    if (no) throw new ErrorDeNegocio(no)
  }
  const g = grupo ?? (movs.length > 1 ? randomUUID() : null)
  const valores = Prisma.join(movs.map(m => Prisma.sql`(
    ${m.productId}::int, ${m.cantidad}::int, ${m.motivo}::text, ${m.costoUnitUsd ?? null}::numeric, ${m.nota?.trim() || null}::text,
    ${m.envioId ?? null}::int, ${m.pedidoId ?? null}::int, ${m.pedidoItemId ?? null}::int, ${m.recepcionId ?? null}::int, ${g}::text)`))
  return Prisma.sql`WITH ${sqlStockDesde(Prisma.sql`VALUES ${valores}`)}`
}

// Inserta los movimientos y actualiza Product.stock en UNA sentencia, dentro de la transacción
// de quien llama (o con `db` cuando es una sola escritura). Las filas de una misma llamada
// comparten `grupo`. Si deja una pieza en negativo, la base lo rechaza y sale StockInsuficiente.
export async function moverStock(tx: Prisma.TransactionClient, movs: MovStock[], grupo?: string): Promise<void> {
  if (movs.length === 0) return
  const sql = sqlMovs(movs, grupo)
  const deltas = new Map<number, number>()
  for (const m of movs) deltas.set(m.productId, (deltas.get(m.productId) ?? 0) + m.cantidad)
  await conStockSuficiente(deltas, () => tx.$executeRaw(sql))
}

// Lo mismo para un lote no interactivo (`db.$transaction([...])`), sin traducir el rechazo: quien
// la usa ya comprobó que el stock alcanza, y la restricción queda como red.
export function sentenciaMoverStock(movs: MovStock[], grupo?: string): Prisma.PrismaPromise<number> {
  return db.$executeRaw(sqlMovs(movs, grupo))
}
