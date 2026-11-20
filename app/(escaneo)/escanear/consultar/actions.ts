'use server'

import { db } from '@/lib/db'
import { buscarPorCodigo, leidoComo } from '@/lib/buscar-codigo'
import { posicionesStock, type CajaDePieza } from '@/lib/inventario'

// Consultar desde el teléfono: solo lee. Una lectura se resuelve contra TODO el catálogo (no
// contra una caja), con lib/buscar-codigo.ts.

const LIMITE = 15

export interface Ficha {
  id: number
  nameEs: string
  bajajCode: string | null
  altSku: string | null
  descontinuada: boolean
  stock: number
  ubicacion: string | null
  contadoAt: Date | null
  precioUsd: number
  medidoAt: Date | null
  medidaBase: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  // Stock propio que viene en cajas confirmadas (la regla de lib/inventario.ts).
  enCamino: CajaDePieza[]
  // Pedidos de clientes confirmados que todavía no se le entregaron.
  pedidos: { pedidoId: number; cliente: string; cantidad: number; etapa: string; envioId: number | null }[]
}

export type Consulta =
  | { tipo: 'ficha'; ficha: Ficha; leidoComo: string | null }
  | { tipo: 'varias'; piezas: { id: number; nameEs: string; bajajCode: string | null }[]; hayMas: boolean }
  | { tipo: 'ninguna'; codigo: string }

export async function consultarCodigo(raw: string, parcial: boolean): Promise<Consulta> {
  const r = await buscarPorCodigo(raw, parcial, LIMITE)
  if (r.piezas.length === 0) return { tipo: 'ninguna', codigo: r.codigo }
  if (r.piezas.length > 1) {
    return { tipo: 'varias', piezas: r.piezas.slice(0, LIMITE), hayMas: r.piezas.length > LIMITE }
  }
  const ficha = await fichaDe(r.piezas[0].id)
  if (!ficha) return { tipo: 'ninguna', codigo: r.codigo }
  return { tipo: 'ficha', ficha, leidoComo: leidoComo(r, ficha.bajajCode) }
}

export async function consultarPieza(id: number): Promise<Consulta> {
  const ficha = await fichaDe(id)
  return ficha ? { tipo: 'ficha', ficha, leidoComo: null } : { tipo: 'ninguna', codigo: `#${id}` }
}

async function fichaDe(id: number): Promise<Ficha | null> {
  // shortcut: posicionesStock recorre todo lo que viene en camino para mirar una pieza; con
  // pocas cajas abiertas no se nota. Si Consultar se pone lento, filtrarla por producto.
  const [p, { porProducto }, items] = await Promise.all([
    db.product.findUnique({
      where: { id },
      select: {
        id: true, nameEs: true, bajajCode: true, altSku: true, discontinuedAt: true, stock: true, price: true, ubicacion: true, contadoAt: true,
        medidoAt: true, medidaBase: true, weightGrams: true, dimL: true, dimA: true, dimH: true,
      },
    }),
    posicionesStock(),
    // shortcut: solo líneas de pieza suelta; una pieza vendida dentro de un conjunto no aparece.
    db.pedidoItem.findMany({
      where: { productId: id, pedido: { tipo: 'cliente', status: 'pedido' }, shippingStatus: { not: 'entregado' } },
      select: { pedidoId: true, quantity: true, shippingStatus: true, envioId: true, pedido: { select: { clientName: true } } },
      orderBy: { pedidoId: 'asc' },
    }),
  ])
  if (!p) return null
  const { discontinuedAt, price, ...resto } = p
  return {
    ...resto,
    descontinuada: discontinuedAt != null,
    precioUsd: Number(price),
    enCamino: porProducto.get(id)?.cajas ?? [],
    pedidos: items.map(i => ({
      pedidoId: i.pedidoId, cliente: i.pedido.clientName, cantidad: i.quantity, etapa: i.shippingStatus, envioId: i.envioId,
    })),
  }
}
