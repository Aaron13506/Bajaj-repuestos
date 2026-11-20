'use server'

import { db } from '@/lib/db'
import { buscarPorCodigo, leidoComo } from '@/lib/buscar-codigo'

// Vender desde el teléfono: solo lee. Cada lectura trae la pieza y cuántas unidades dice la
// etiqueta; el carrito vive en la pantalla y se cobra en /ventas/new, que vuelve a validar todo.

const LIMITE = 15

export interface PiezaVendible {
  id: number
  nameEs: string
  bajajCode: string | null
  stock: number
}

export type LecturaVenta =
  | { tipo: 'pieza'; pieza: PiezaVendible; cantidad: number; leidoComo: string | null }
  | { tipo: 'varias'; piezas: PiezaVendible[]; hayMas: boolean }
  | { tipo: 'ninguna'; codigo: string }

const SELECT = { id: true, nameEs: true, bajajCode: true, stock: true } as const

export async function leerParaVender(raw: string, parcial: boolean): Promise<LecturaVenta> {
  const r = await buscarPorCodigo(raw, parcial, LIMITE)
  if (r.piezas.length === 0) return { tipo: 'ninguna', codigo: r.codigo }
  const piezas = await db.product.findMany({ where: { id: { in: r.piezas.slice(0, LIMITE).map(p => p.id) } }, select: SELECT, orderBy: { nameEs: 'asc' } })
  if (r.piezas.length > 1) return { tipo: 'varias', piezas, hayMas: r.piezas.length > LIMITE }
  if (piezas.length === 0) return { tipo: 'ninguna', codigo: r.codigo }
  return { tipo: 'pieza', pieza: piezas[0], cantidad: r.cantidad, leidoComo: leidoComo(r, piezas[0].bajajCode) }
}

// Elegida de la lista de "varias": suma 1, como lo tecleado.
export async function piezaParaVender(id: number): Promise<LecturaVenta> {
  const p = await db.product.findUnique({ where: { id }, select: SELECT })
  return p ? { tipo: 'pieza', pieza: p, cantidad: 1, leidoComo: null } : { tipo: 'ninguna', codigo: `#${id}` }
}
