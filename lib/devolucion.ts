// Leer del formulario una devolución al cliente (puro: solo mira el FormData).
//
// Se escribe en dólares REALES —lo que sale de caja y deja de contar como cobrado—, porque una
// devolución no tiene la ambigüedad BCV de un cobro: lo guardado es real y es lo que se devuelve.
// Si se le devuelve en Bs, además se anotan los bolívares que se entregaron y a qué tasa, sin
// derivar uno del otro: lo que se entregó en el banco es lo que se puede cuadrar contra el
// estado de cuenta (igual que un cobro, ver lib/cuentas.ts).
import { cobraEnBolivares, METODOS_PAGO_INGRESO } from '@/lib/pagos'
import type { DatosBs } from '@/lib/cuentas'

// Se le devuelve por donde pagó: los mismos métodos con que se cobra.
export const METODOS_DEVOLUCION = METODOS_PAGO_INGRESO

export interface DevolucionLeida {
  monto: number
  metodoPago: string
  fecha: Date
  bs: DatosBs | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function leerDevolucion(
  fd: FormData,
): { ok: true; devolucion: DevolucionLeida | null } | { ok: false; error: string } {
  const numero = (k: string) => parseFloat(String(fd.get(k) ?? '').trim().replace(',', '.'))
  const crudo = String(fd.get('devolverUsd') ?? '').trim()
  // Vacío o 0 = no se devuelve nada. Un texto ilegible NO es eso: se rechaza.
  if (crudo === '') return { ok: true, devolucion: null }
  const monto = numero('devolverUsd')
  if (!Number.isFinite(monto) || monto < 0) return { ok: false, error: 'El monto a devolver no es un número válido.' }
  if (monto === 0) return { ok: true, devolucion: null }

  const metodoPago = String(fd.get('devolverMetodo') ?? '').trim()
  if (!(METODOS_DEVOLUCION as readonly string[]).includes(metodoPago)) {
    return { ok: false, error: 'Elegí con qué se le devuelve.' }
  }
  const rawFecha = String(fd.get('devolverFecha') ?? '').trim()
  const fecha = rawFecha ? new Date(`${rawFecha}T12:00:00`) : new Date()

  let bs: DatosBs | null = null
  if (cobraEnBolivares(metodoPago)) {
    const montoBs = numero('devolverBs')
    const tasaBs = numero('devolverTasa')
    if (!Number.isFinite(montoBs) || montoBs <= 0) return { ok: false, error: 'Escribí cuántos bolívares se le entregaron.' }
    if (!Number.isFinite(tasaBs) || tasaBs <= 0) return { ok: false, error: 'Escribí la tasa (Bs por dólar) de ese día.' }
    bs = { montoBs: round2(montoBs), tasaBs }
  }
  return { ok: true, devolucion: { monto: round2(monto), metodoPago, fecha, bs } }
}
