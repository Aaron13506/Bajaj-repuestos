'use server'

import { bultoDeLlegada, camposBulto } from '@/lib/cajas-envio'
import { revalidatePath } from 'next/cache'
import { conErrorDeNegocio, ErrorDeNegocio, fallo, type ActionResult } from '@/lib/action-result'
import type { OrigenLectura } from '@/lib/qr-bajaj'
import { buscarPorCodigo } from '@/lib/buscar-codigo'
import {
  abrirRecepcion, anotarCodigo, anotarSinIdentificar, cambiarCiego, cerrarRecepcion, corregirConteo,
  descartarRecepcion, deshacerLectura, identificar, registrarLectura, revertirRecepcion, type ResultadoLectura,
} from '@/lib/recepcion-db'

// La recepción de una caja (docs/plan-inventario/03-recepcion.md): las mismas acciones para la
// laptop (/envios/[id], pestaña Llegada) y el teléfono (/escanear/recepcion/[id]). La lógica vive en
// lib/recepcion-db.ts; acá solo se traduce el error y se revalida.
//
// Las lecturas no revalidan nada: la laptop refresca sola cada 3 s mientras la recepción está
// abierta, y el teléfono pinta lo que le devuelve cada acción.

const ORIGENES: OrigenLectura[] = ['camara', 'lector', 'manual']
const origenDe = (o: string): OrigenLectura => (ORIGENES.includes(o as OrigenLectura) ? (o as OrigenLectura) : 'manual')

export type ResultadoAccionLectura = { ok: true; r: ResultadoLectura } | { ok: false; error: string; codigo?: string }

async function conResultado<T>(cuerpo: () => Promise<T>): Promise<{ ok: true; r: T } | { ok: false; error: string; codigo?: string }> {
  try {
    return { ok: true, r: await cuerpo() }
  } catch (e) {
    if (e instanceof ErrorDeNegocio) return fallo(e.message, e.codigo)
    throw e
  }
}

function revalidarRecepcion(envioId: number) {
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/inventario')
  revalidatePath('/products')
  revalidatePath('/presupuestos')
  revalidatePath('/contabilidad')
  revalidatePath('/resultados')
  revalidatePath('/')
}

// Check-in: la caja está en mis manos. Abre la recepción (si hay algo que contar). El peso y las
// medidas del bulto son opcionales (lib/cajas-envio.ts bultoDeLlegada).
export async function marcarLlegada(envioId: number, formData: FormData): Promise<ActionResult> {
  const nota = String(formData.get('nota') ?? '')
  const b = bultoDeLlegada(camposBulto(formData))
  if ('error' in b) return { ok: false, error: b.error }
  const r = await conErrorDeNegocio(() => abrirRecepcion(envioId, { llegada: true, nota, bulto: b.bulto }))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  return r
}

// Contar sin marcar la llegada todavía, o "Contar lo que faltaba" (un backorder que llegó).
export async function abrirConteo(envioId: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => abrirRecepcion(envioId))
  revalidatePath(`/envios/${envioId}`)
  return r
}

export async function leerEnRecepcion(recepcionId: number, raw: string, origen: string, lineaId?: number): Promise<ResultadoAccionLectura> {
  return conResultado(() => registrarLectura(recepcionId, raw, origenDe(origen), lineaId))
}

export async function anotarEnRecepcion(recepcionId: number, raw: string, origen: string): Promise<ResultadoAccionLectura> {
  return conResultado(() => anotarCodigo(recepcionId, raw, origenDe(origen)))
}

export async function corregirFila(lineaId: number, total: number): Promise<{ ok: true; r: Awaited<ReturnType<typeof corregirConteo>> } | { ok: false; error: string; codigo?: string }> {
  return conResultado(() => corregirConteo(lineaId, total))
}

export async function deshacerEnRecepcion(lecturaId: number) {
  return conResultado(() => deshacerLectura(lecturaId))
}

export async function sinIdentificarEnRecepcion(recepcionId: number, nota: string, cantidad: number): Promise<ActionResult> {
  return conErrorDeNegocio(() => anotarSinIdentificar(recepcionId, nota, cantidad))
}

// Asigna una fila sin identificar (o fuera del catálogo) a la pieza de un código tecleado.
export async function identificarFila(lineaId: number, raw: string): Promise<ActionResult> {
  return conErrorDeNegocio(async () => {
    const r = await buscarPorCodigo(raw, false, 1)
    if (r.piezas.length === 0) throw new ErrorDeNegocio(`${r.codigo || raw} no está en el catálogo: creá la pieza primero.`)
    if (r.piezas.length > 1) throw new ErrorDeNegocio(`${r.codigo} corresponde a más de una pieza: escribí el código exacto.`)
    await identificar(lineaId, r.piezas[0].id)
  })
}

export async function ciegoEnRecepcion(recepcionId: number, envioId: number, ciego: boolean): Promise<ActionResult> {
  await cambiarCiego(recepcionId, ciego)
  revalidatePath(`/envios/${envioId}`)
  return { ok: true }
}

// `decisiones`: por id de fila, 'backorder' | 'faltante' | 'equivocada'.
export async function cerrarEnRecepcion(recepcionId: number, envioId: number, decisiones: Record<number, string>): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => cerrarRecepcion(recepcionId, decisiones))
  revalidarRecepcion(envioId)
  return r
}

export async function revertirEnRecepcion(recepcionId: number, envioId: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => revertirRecepcion(recepcionId))
  revalidarRecepcion(envioId)
  return r
}

// Descartar un conteo abierto por error: no movió nada, se borra (y la llegada, si era la única).
export async function descartarEnRecepcion(recepcionId: number, envioId: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => descartarRecepcion(recepcionId))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  return r
}
