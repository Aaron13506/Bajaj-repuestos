'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { conErrorDeNegocio, ErrorDeNegocio, fallo, type ActionResult } from '@/lib/action-result'
import { db } from '@/lib/db'
import {
  abrirConteoEstante, abrirConteoLista, asignarUbicacion, cerrarConteo, corregirEnConteo, leerEnConteo, moverAlEstante,
  type ResultadoConteo,
} from '@/lib/conteo-inventario-db'

// Ubicaciones y conteo cíclico (docs/plan-inventario/05-ubicaciones-conteo.md): las mismas acciones
// para el teléfono (/escanear/inventario) y la laptop (/inventario/conteo). La lógica vive en
// lib/conteo-inventario-db.ts; acá solo se traduce el error y se revalida.

type Res<T> = { ok: true; r: T } | { ok: false; error: string; codigo?: string }

async function conResultado<T>(cuerpo: () => Promise<T>): Promise<Res<T>> {
  try {
    return { ok: true, r: await cuerpo() }
  } catch (e) {
    if (e instanceof ErrorDeNegocio) return fallo(e.message, e.codigo)
    throw e
  }
}

function revalidarUbicacion() {
  revalidatePath('/inventario')
  revalidatePath('/products')
}

export async function abrirEstante(formData: FormData): Promise<ActionResult> {
  let id = 0
  const r = await conErrorDeNegocio(async () => { id = await abrirConteoEstante(String(formData.get('estante') ?? '')) })
  if (!r.ok) return r
  revalidatePath('/inventario/conteo')
  redirect(`/escanear/inventario/${id}`)
}

// La lista sugerida de /inventario/conteo: `piezas` = ids marcados.
export async function abrirLista(formData: FormData): Promise<ActionResult> {
  let id = 0
  const r = await conErrorDeNegocio(async () => { id = await abrirConteoLista(formData.getAll('pieza').map(Number)) })
  if (!r.ok) return r
  revalidatePath('/inventario/conteo')
  redirect(`/escanear/inventario/${id}`)
}

export async function leerEnInventario(conteoId: number, raw: string, manual: boolean, productId?: number): Promise<Res<ResultadoConteo>> {
  return conResultado(() => leerEnConteo(conteoId, raw, manual, productId))
}

export async function corregirEnInventario(lineaId: number, total: number | null, si?: number | null) {
  return conResultado(() => corregirEnConteo(lineaId, total, si))
}

export async function moverAlEstanteDelConteo(conteoId: number, productId: number) {
  const r = await conResultado(() => moverAlEstante(conteoId, productId))
  if (r.ok) revalidarUbicacion()
  return r
}

export async function cerrarInventario(conteoId: number, notas: string): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => cerrarConteo(conteoId, notas))
  revalidatePath(`/escanear/inventario/${conteoId}`)
  revalidatePath('/inventario/conteo')
  revalidarUbicacion()
  revalidatePath('/')
  return r
}

// Desde Consultar: escaneás la pieza y después el estante (o lo escribís). Vacío = sin ubicación.
export async function ubicarPieza(productId: number, raw: string) {
  const r = await conResultado(() => db.$transaction(tx => asignarUbicacion(tx, productId, raw.trim() || null)))
  if (r.ok) revalidarUbicacion()
  return r
}
