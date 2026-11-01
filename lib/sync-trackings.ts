// La parte de TrackingMore que toca la base: refrescar la lista de couriers y poner al día
// los trackings de las cajas. La corre cada hora pnpm tracking:sync (bajaj-tracking.timer) y,
// para una caja, el botón "Actualizar ahora". Ver lib/trackingmore.ts.
//
// Las escrituras van guardadas por lo que se leyó (id + número + courier): si el dueño editó
// los trackings de la caja mientras corría, la fila ya no es la misma y la respuesta vieja no
// la pisa.

import type { Prisma } from '@prisma/client'
import { db } from './db'
import {
  apiConsultar, apiCouriers, apiKeyTrackingMore, apiRegistrar, COURIERS_VIGENCIA_DIAS, datosDeTracking,
  ErrorTrackingMore, mismoTracking, TM_LOTE, TM_PAUSA_CREATE_MS, type CourierTM, type TrackingTM,
} from './trackingmore'

const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function listaCouriers(): Promise<CourierTM[]> {
  return db.trackingCourier.findMany({ select: { code: true, nombre: true, pais: true }, orderBy: { nombre: 'asc' } })
}

/** Baja la lista de couriers si no hay o si tiene más de una semana. Devuelve cuántos hay. */
export async function refrescarCouriers(apiKey: string, { forzar = false } = {}): Promise<{ total: number; refrescada: boolean }> {
  const viejo = await db.trackingCourier.findFirst({ orderBy: { actualizadoEn: 'asc' }, select: { actualizadoEn: true } })
  const total = await db.trackingCourier.count()
  const limite = Date.now() - COURIERS_VIGENCIA_DIAS * 24 * 3600 * 1000
  if (!forzar && total > 0 && viejo && viejo.actualizadoEn.getTime() > limite) return { total, refrescada: false }
  const lista = await apiCouriers(apiKey)
  // Una lista vacía es una respuesta rota, no "TrackingMore ya no sigue a nadie".
  if (lista.length === 0) return { total, refrescada: false }
  await db.$transaction([
    db.trackingCourier.deleteMany({}),
    db.trackingCourier.createMany({ data: lista.map(c => ({ ...c, actualizadoEn: new Date() })) }),
  ])
  return { total: lista.length, refrescada: true }
}

export type ResumenSync = {
  apagado?: true
  registrados: number
  actualizados: number
  conError: number
  /** Lo que cortó la corrida (clave, cupo, red). Lo hecho antes queda guardado. */
  error?: string
}

type Fila = { id: number; envioId: number; tramo: string; numero: string; courierCode: string | null; tmId: string | null }

async function guardar(f: Fila, t: TrackingTM) {
  const d = datosDeTracking(t)
  const r = await db.envioTracking.updateMany({
    where: { id: f.id, numero: f.numero, courierCode: f.courierCode },
    data: {
      tmId: d.tmId ?? f.tmId,
      estado: d.estado,
      subestado: d.subestado,
      ultimoEvento: d.ultimoEvento,
      ultimoEventoEn: d.ultimoEventoEn,
      eventos: d.eventos as unknown as Prisma.InputJsonValue,
      consultadoEn: new Date(),
      errorSeguimiento: null,
    },
  })
  return r.count
}

/**
 * Pone al día los trackings con courier que todavía no llegaron (ni vencieron). Con `envioId`
 * solo los de esa caja, y además reintenta los que habían dado error (el dueño lo pidió).
 */
export async function sincronizarTrackings({ envioId }: { envioId?: number } = {}): Promise<ResumenSync> {
  const apiKey = apiKeyTrackingMore()
  const resumen: ResumenSync = { registrados: 0, actualizados: 0, conError: 0 }
  if (!apiKey) return { ...resumen, apagado: true }

  try {
    if (envioId != null) {
      await db.envioTracking.updateMany({ where: { envioId, errorSeguimiento: { not: null } }, data: { errorSeguimiento: null } })
    }
    const filas: Fila[] = await db.envioTracking.findMany({
      where: {
        courierCode: { not: null },
        errorSeguimiento: null,
        OR: [{ estado: null }, { estado: { notIn: ['delivered', 'expired'] } }],
        ...(envioId != null ? { envioId } : {}),
      },
      select: { id: true, envioId: true, tramo: true, numero: true, courierCode: true, tmId: true },
      orderBy: { id: 'asc' },
    })

    // 1. Registrar lo nuevo. La respuesta ya trae el estado: eso queda guardado y no se
    // vuelve a consultar en esta corrida.
    const listos = new Set<number>()
    for (const f of filas.filter(f => !f.tmId)) {
      const r = await apiRegistrar(apiKey, { numero: f.numero, courierCode: f.courierCode!, nota: `Caja #${f.envioId} · ${f.tramo}` })
      if ('creado' in r) {
        resumen.registrados++
        resumen.actualizados += await guardar(f, r.creado)
        listos.add(f.id)
      } else if ('error' in r) {
        resumen.conError++
        listos.add(f.id)
        await db.envioTracking.updateMany({
          where: { id: f.id, numero: f.numero, courierCode: f.courierCode },
          data: { errorSeguimiento: r.error, consultadoEn: new Date() },
        })
      }
      // 'existe': ya estaba registrado (otra caja, o una corrida que se cortó); se lee abajo.
      await esperar(TM_PAUSA_CREATE_MS)
    }

    // 2. Consultar el resto, de a 40 números.
    const pendientes = filas.filter(f => !listos.has(f.id))
    const numeros = [...new Set(pendientes.map(f => f.numero))]
    for (let i = 0; i < numeros.length; i += TM_LOTE) {
      const lote = numeros.slice(i, i + TM_LOTE)
      const resultados = await apiConsultar(apiKey, lote)
      for (const f of pendientes.filter(p => lote.includes(p.numero))) {
        const t = resultados.find(r => mismoTracking(f, r))
        if (t) resumen.actualizados += await guardar(f, t)
      }
    }
    return resumen
  } catch (e) {
    if (e instanceof ErrorTrackingMore) return { ...resumen, error: e.message }
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'TypeError')) {
      return { ...resumen, error: `No se pudo hablar con TrackingMore: ${e.message}` }
    }
    throw e
  }
}
