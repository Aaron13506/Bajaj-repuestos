'use server'

import { db } from '@/lib/db'
import { buscarPorCodigo, leidoComo } from '@/lib/buscar-codigo'

// Modo Medir: una lectura (o lo tecleado) contra todo el catálogo, sin contar nada. Devuelve la
// pieza con lo que tiene guardado y cuántas unidades traía la etiqueta (una bolsa de N → N).
// Lo que se guarda pasa por medirPieza (products/actions.ts), igual que en el conteo.

const LIMITE = 15

export interface PiezaMedir {
  productId: number
  nameEs: string
  bajajCode: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  medidoAt: Date | null
  medidaBase: string | null
}

export type LecturaMedir =
  | { tipo: 'pieza'; pieza: PiezaMedir; cantidad: number; leidoComo: string | null }
  | { tipo: 'varias'; piezas: { id: number; nameEs: string; bajajCode: string | null }[]; hayMas: boolean; cantidad: number }
  | { tipo: 'ninguna'; codigo: string }

export async function leerParaMedir(raw: string, parcial: boolean): Promise<LecturaMedir> {
  const r = await buscarPorCodigo(raw, parcial, LIMITE)
  if (r.piezas.length === 0) return { tipo: 'ninguna', codigo: r.codigo }
  if (r.piezas.length > 1) return { tipo: 'varias', piezas: r.piezas.slice(0, LIMITE), hayMas: r.piezas.length > LIMITE, cantidad: r.cantidad }
  const pieza = await piezaDe(r.piezas[0].id)
  if (!pieza) return { tipo: 'ninguna', codigo: r.codigo }
  return { tipo: 'pieza', pieza, cantidad: r.cantidad, leidoComo: leidoComo(r, pieza.bajajCode) }
}

export async function piezaParaMedir(id: number, cantidad = 1): Promise<LecturaMedir> {
  const pieza = await piezaDe(id)
  return pieza ? { tipo: 'pieza', pieza, cantidad, leidoComo: null } : { tipo: 'ninguna', codigo: `#${id}` }
}

async function piezaDe(id: number): Promise<PiezaMedir | null> {
  const p = await db.product.findUnique({
    where: { id },
    select: {
      id: true, nameEs: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true,
      medidoAt: true, medidaBase: true,
    },
  })
  if (!p) return null
  const { id: productId, ...resto } = p
  return { productId, ...resto }
}
