// Las cuentas donde está la plata (puro, sin DB: lo usan el server, los formularios y
// check:costeo).
//
// El saldo de caja era un solo número en dólares, y esconde lo que más pesa en este negocio:
// los Bs en el banco se devalúan, el efectivo y los USDT no, y pasar de uno a otro cuesta. Cada
// Movimiento dice ahora en qué cuenta pasó (`Movimiento.cuenta`), y si fue en bolívares,
// cuántos y a qué tasa. `Movimiento.monto` sigue siendo dólares reales y es lo único que suma
// la caja: esto es el detalle de dónde está, no otra unidad.
import { METODOS_PAGO_INGRESO, METODOS_PAGO_EGRESO, cobraEnBolivares } from '@/lib/pagos'

export const CUENTAS = ['banco_bs', 'efectivo_usd', 'usdt', 'banco_usd'] as const
export type Cuenta = (typeof CUENTAS)[number]

export const CUENTA_LABELS: Record<Cuenta, string> = {
  banco_bs: 'Banco (Bs)',
  efectivo_usd: 'Efectivo USD',
  usdt: 'Binance (USDT)',
  banco_usd: 'Banco (USD)',
}

// La cuenta sale del método con que se pagó o cobró; no se le pide al usuario otra vez.
export function cuentaDeMetodo(metodo: string | null | undefined): Cuenta | null {
  switch (metodo) {
    case METODOS_PAGO_INGRESO[0]: return 'banco_bs'
    case METODOS_PAGO_INGRESO[1]: return 'efectivo_usd'
    case METODOS_PAGO_INGRESO[2]: return 'usdt'
    // La tarjeta es la Binance Card: gasta directo de los USDT, no es una cuenta aparte.
    case METODOS_PAGO_EGRESO[1]: return 'usdt'
    case METODOS_PAGO_EGRESO[0]: return 'banco_usd' // Giro bancario
    default: return null
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface DatosBs {
  montoBs: number
  tasaBs: number
}

// Los Bs que pasaron por la cuenta. Si el formulario los trajo exactos (lo que se recibió en el
// banco) se guardan tal cual; si no, salen de lo escrito por la tasa. Solo hay Bs si el método
// es en Bs: null para el resto.
export function datosBs(
  metodo: string | null | undefined,
  montoEscrito: number,
  tasaBs: number | null,
  bsExactos?: number | null,
): DatosBs | null {
  if (!cobraEnBolivares(metodo) || tasaBs == null) return null
  return { montoBs: bsExactos ?? round2(montoEscrito * tasaBs), tasaBs }
}

// Un cobro escrito en bolívares: lo que entró al banco y la tasa (Bs por dólar) de ESE día.
// Los dólares salen de dividir, no se escriben: en un pedido a dólar BCV son dólares BCV (la
// tasa es la del BCV); en cualquier otro cobro, dólares reales (la tasa de cobro directo). El
// resto de la cadena (lib/cobro-bcv.ts) trabaja con ese monto como siempre.
export interface CobroEnBs extends DatosBs {
  montoUsd: number
}

// Lee el cobro en Bs de un formulario. Con un método que no es en Bs devuelve `cobro: null` y
// el llamador sigue con su monto en dólares. Con `opcional`, dejar los Bs vacíos también da
// null ("todavía no pagó"); sin él, vacío se rechaza: no es cero, es un dato que falta.
// `sufijo` lee un segundo cobro del mismo formulario (montoBs2/tasaBs2).
export function leerCobroBs(
  fd: FormData,
  metodo: string | null | undefined,
  opcional = false,
  sufijo = '',
): { ok: true; cobro: CobroEnBs | null } | { ok: false; error: string } {
  if (!cobraEnBolivares(metodo)) return { ok: true, cobro: null }
  const num = (k: string) => parseFloat(String(fd.get(k) ?? '').trim().replace(',', '.'))
  const rawBs = String(fd.get(`montoBs${sufijo}`) ?? '').trim()
  if (opcional && rawBs === '') return { ok: true, cobro: null }

  const montoBs = num(`montoBs${sufijo}`)
  if (!Number.isFinite(montoBs) || montoBs <= 0) return { ok: false, error: 'Escribí cuántos bolívares recibiste.' }
  const tasaBs = num(`tasaBs${sufijo}`)
  if (!Number.isFinite(tasaBs) || tasaBs <= 0) {
    return { ok: false, error: 'Escribí la tasa (Bs por dólar) de ese día: sin ella no se sabe cuántos dólares son.' }
  }
  const montoUsd = round2(montoBs / tasaBs)
  if (montoUsd <= 0) return { ok: false, error: 'Esos bolívares no llegan a un centavo a esa tasa: revisá los montos.' }
  return { ok: true, cobro: { montoBs: round2(montoBs), tasaBs, montoUsd } }
}
