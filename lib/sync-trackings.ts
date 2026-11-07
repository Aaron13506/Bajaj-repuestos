// La parte de Ship24 que toca la base: refrescar la lista de couriers y poner al día los
// trackings de las cajas. La corre cada hora pnpm tracking:sync (bajaj-tracking.timer) y, para
// una caja, el botón "Actualizar ahora". Ver lib/ship24.ts.
//
// Las escrituras van guardadas por lo que se leyó (id + número + courier): si el dueño editó
// los trackings de la caja mientras corría, la fila ya no es la misma y la respuesta vieja no
// la pisa.

import type { Prisma } from '@prisma/client'
import { db } from './db'
import {
  apiConsultar, apiCouriers, apiKeyShip24, apiRegistrar, COURIERS_VIGENCIA_DIAS, cuerpoTracker, datosDeTracking,
  ErrorShip24, ESTADOS_FINALES, S24_PAUSA_MS, type Courier, type TrackingS24,
} from './ship24'
import { credencialesOneway, detalleOneway, entrarOneway, ErrorOneway, ONEWAY_CODE, pedidosOneway } from './oneway'

const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function listaCouriers(): Promise<Courier[]> {
  return db.trackingCourier.findMany({ select: { code: true, nombre: true, pais: true }, orderBy: { nombre: 'asc' } })
}

/** Baja la lista de couriers si no hay o si tiene más de una semana. Devuelve cuántos hay. */
export async function refrescarCouriers(apiKey: string, { forzar = false } = {}): Promise<{ total: number; refrescada: boolean }> {
  const viejo = await db.trackingCourier.findFirst({ orderBy: { actualizadoEn: 'asc' }, select: { actualizadoEn: true } })
  const total = await db.trackingCourier.count()
  const limite = Date.now() - COURIERS_VIGENCIA_DIAS * 24 * 3600 * 1000
  if (!forzar && total > 0 && viejo && viejo.actualizadoEn.getTime() > limite) return { total, refrescada: false }
  const lista = await apiCouriers(apiKey)
  // Una lista vacía es una respuesta rota, no "Ship24 ya no sigue a nadie".
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

type Fila = { id: number; envioId: number; tramo: string; numero: string; courierCode: string | null; trackerId: string | null }

const dondeFila = (f: Fila) => ({ id: f.id, numero: f.numero, courierCode: f.courierCode })

async function guardar(f: Fila, t: TrackingS24) {
  const d = datosDeTracking(t)
  const r = await db.envioTracking.updateMany({
    where: dondeFila(f),
    data: {
      trackerId: d.trackerId ?? f.trackerId,
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

async function marcarError(f: Fila, error: string) {
  await db.envioTracking.updateMany({ where: dondeFila(f), data: { errorSeguimiento: error, consultadoEn: new Date() } })
}

/**
 * Pone al día los trackings con courier que todavía no llegaron (ni dejaron de seguirse). Con
 * `envioId` solo los de esa caja, y además reintenta los que habían dado error (el dueño lo
 * pidió).
 */
export async function sincronizarTrackings({ envioId }: { envioId?: number } = {}): Promise<ResumenSync> {
  const apiKey = apiKeyShip24()
  const resumen: ResumenSync = { registrados: 0, actualizados: 0, conError: 0 }
  if (!apiKey) return { ...resumen, apagado: true }

  try {
    if (envioId != null) {
      await db.envioTracking.updateMany({ where: { envioId, errorSeguimiento: { not: null } }, data: { errorSeguimiento: null } })
    }
    const filas: Fila[] = await db.envioTracking.findMany({
      where: {
        courierCode: { not: null, notIn: [ONEWAY_CODE] },
        errorSeguimiento: null,
        OR: [{ estado: null }, { estado: { notIn: [...ESTADOS_FINALES] } }],
        ...(envioId != null ? { envioId } : {}),
      },
      select: { id: true, envioId: true, tramo: true, numero: true, courierCode: true, trackerId: true },
      orderBy: { id: 'asc' },
    })
    const couriers = new Set((await listaCouriers()).map(c => c.code))

    for (const f of filas) {
      let r: { tracking: TrackingS24 } | { error: string }
      if (f.trackerId) {
        r = await apiConsultar(apiKey, f.trackerId)
      } else {
        // Un code que no está en la lista (quedó de antes, o Ship24 lo dio de baja) crearía un
        // tracker que Ship24 sigue "a ciegas": mejor que el dueño lo elija de nuevo.
        const cuerpo = couriers.size > 0 && !couriers.has(f.courierCode!)
          ? { error: `El courier «${f.courierCode}» no está en la lista de Ship24: elegilo de nuevo en la caja.` }
          : cuerpoTracker({ envioId: f.envioId, tramo: f.tramo, numero: f.numero, courierCode: f.courierCode! })
        r = 'error' in cuerpo ? cuerpo : await apiRegistrar(apiKey, cuerpo)
        if ('tracking' in r) resumen.registrados++
      }
      if ('tracking' in r) {
        resumen.actualizados += await guardar(f, r.tracking)
      } else {
        resumen.conError++
        await marcarError(f, r.error)
      }
      await esperar(S24_PAUSA_MS)
    }
    return resumen
  } catch (e) {
    if (e instanceof ErrorShip24) return { ...resumen, error: e.message }
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'TypeError')) {
      return { ...resumen, error: `No se pudo hablar con Ship24: ${e.message}` }
    }
    throw e
  }
}

/**
 * Pone al día los códigos de One Way Cargo (tramo Venezuela) que todavía no llegaron. Entra a
 * la cuenta solo si hay alguno pendiente. Con `envioId`, solo esa caja y reintenta los que
 * tenían error. Ver lib/oneway.ts.
 */
export async function sincronizarOneway({ envioId }: { envioId?: number } = {}): Promise<ResumenSync> {
  const cred = credencialesOneway()
  const resumen: ResumenSync = { registrados: 0, actualizados: 0, conError: 0 }
  if (!cred) return { ...resumen, apagado: true }

  if (envioId != null) {
    await db.envioTracking.updateMany({ where: { envioId, courierCode: ONEWAY_CODE, errorSeguimiento: { not: null } }, data: { errorSeguimiento: null } })
  }
  const filas: Fila[] = await db.envioTracking.findMany({
    where: {
      courierCode: ONEWAY_CODE,
      errorSeguimiento: null,
      OR: [{ estado: null }, { estado: { notIn: [...ESTADOS_FINALES] } }],
      ...(envioId != null ? { envioId } : {}),
    },
    select: { id: true, envioId: true, tramo: true, numero: true, courierCode: true, trackerId: true },
    orderBy: { id: 'asc' },
  })
  if (filas.length === 0) return resumen

  try {
    const sesion = await entrarOneway(cred)
    const pedidos = await pedidosOneway(sesion)
    for (const f of filas) {
      const uuid = pedidos.get(f.numero.trim().toUpperCase())
      const d = uuid ? await detalleOneway(sesion, uuid) : null
      if (!d || d.eventos.length === 0) {
        resumen.conError++
        await marcarError(f, !d
          ? 'One Way Cargo no muestra ese código en la cuenta. Si viajó consolidado, anotá el CON-….'
          : 'No se pudo leer el historial en One Way Cargo (¿cambió la página?).')
        continue
      }
      const r = await db.envioTracking.updateMany({
        where: dondeFila(f),
        data: {
          trackerId: uuid,
          estado: d.estado,
          subestado: d.subestado,
          ultimoEvento: d.eventos[0].detalle,
          ultimoEventoEn: d.eventos[0].fecha,
          eventos: d.eventos as unknown as Prisma.InputJsonValue,
          consultadoEn: new Date(),
          errorSeguimiento: null,
        },
      })
      resumen.actualizados += r.count
      await esperar(1000)
    }
    return resumen
  } catch (e) {
    if (e instanceof ErrorOneway) return { ...resumen, error: e.message }
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'TypeError')) {
      return { ...resumen, error: `No se pudo hablar con One Way Cargo: ${e.message}` }
    }
    throw e
  }
}
