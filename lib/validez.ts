// Validez de un presupuesto y el escalón con el que se le presentó al cliente (puro, sin DB).
//
// La validez eran "7 días" escritos en el PDF y nada más: un presupuesto de hace dos meses se
// aprobaba igual, con precios y tasas de entonces. Y el escalón BCV se congelaba el día de
// aprobar, no el del PDF que el cliente había visto — el total que aceptó podía cambiar justo
// al confirmarlo.
//
// Ahora un presupuesto guarda CUÁNDO se cotizó (`cotizadoAt`) y con qué escalón
// (`escalonCotizadoPct`). Se muestra, se imprime y se aprueba con ese escalón mientras esté
// vigente. Pasado el plazo no se aprueba: se RENUEVA (nueva fecha, escalón de hoy), que es el
// momento de mirar si los precios siguen valiendo.
//
// Un presupuesto anterior a esto no tiene ninguno de los dos: vale desde que se creó y se
// presenta con el escalón de hoy, que es como siempre se hizo.

export const VALIDEZ_DIAS_DEFAULT = 7

const HORAS_VE = 4 // Venezuela: UTC−4 todo el año, sin horario de verano.

// Cuántos días vale un presupuesto (Config `presupuesto_validez_dias`). Un valor ilegible o
// menor a 1 cae al default: una validez de 0 vencería todo apenas se emite.
export function validezDias(cfg: Record<string, string>): number {
  const v = parseInt(cfg['presupuesto_validez_dias'] ?? '', 10)
  return Number.isFinite(v) && v >= 1 ? v : VALIDEZ_DIAS_DEFAULT
}

// El último instante del día (hora de Venezuela) en que cae `d`. Un presupuesto emitido a las
// 15:00 con 7 días de validez vale todo el día 7: vencerlo a las 15:00 le quita horas que el
// PDF promete ("válido hasta el 20 de octubre").
export function finDelDiaVe(d: Date): Date {
  const local = new Date(d.getTime() - HORAS_VE * 3600 * 1000)
  const finLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999)
  return new Date(finLocal + HORAS_VE * 3600 * 1000)
}

export interface PresupuestoFechas {
  cotizadoAt: Date | null
  createdAt: Date
}

// Desde cuándo vale: la última vez que se cotizó o renovó; los anteriores, su creación.
export function cotizadoDe(p: PresupuestoFechas): Date {
  return p.cotizadoAt ?? p.createdAt
}

export interface EstadoValidez {
  desde: Date
  venceEl: Date
  vencido: boolean
  /** Días enteros que quedan contando hoy; 0 = vence hoy; negativo = ya venció. */
  diasRestantes: number
}

export function estadoValidez(p: PresupuestoFechas, dias: number, ahora: Date = new Date()): EstadoValidez {
  const desde = cotizadoDe(p)
  const venceEl = finDelDiaVe(new Date(desde.getTime() + dias * 24 * 3600 * 1000))
  const msPorDia = 24 * 3600 * 1000
  return {
    desde,
    venceEl,
    vencido: ahora.getTime() > venceEl.getTime(),
    diasRestantes: Math.floor((venceEl.getTime() - ahora.getTime()) / msPorDia),
  }
}

// El escalón con el que se le presenta un presupuesto al cliente: el que se congeló al
// cotizarlo, y si es uno anterior a esto (sin congelar), el de hoy.
export function escalonDelPresupuesto(
  escalonCotizadoPct: number | null | undefined,
  vigenteHoy: number | null,
): number | null {
  return escalonCotizadoPct != null ? escalonCotizadoPct : vigenteHoy
}

// Por qué no se puede aprobar, o null si se puede. Solo mira la fecha: las descontinuadas se
// revisan aparte, contra el catálogo (ver bloquearDescontinuadas).
export function motivoNoAprobable(e: EstadoValidez): string | null {
  if (!e.vencido) return null
  const fecha = e.venceEl.toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Caracas' })
  return `El presupuesto venció el ${fecha}: los precios y la tasa BCV de entonces ya no valen. Renovalo (revisá los precios) antes de confirmarlo.`
}

// ── Cerrar presupuestos y medir cuántos se convierten ────────────────────────────────────────
//
// Un presupuesto de cliente termina de una de tres formas: se confirma (pasa a pedido, y si
// después se cancela igual fue una venta cerrada), se pierde (el cliente dijo que no:
// `perdidoAt`) o vence sin respuesta. Mientras no pasa nada de eso, está abierto y hay que
// seguirlo.
export type CierrePresupuesto = 'confirmado' | 'perdido' | 'vencido' | 'abierto'

export interface PresupuestoCierre extends PresupuestoFechas {
  status: string
  perdidoAt: Date | null
}

export function cierreDe(p: PresupuestoCierre, dias: number, ahora: Date = new Date()): CierrePresupuesto {
  if (p.status !== 'presupuesto') return 'confirmado'
  if (p.perdidoAt) return 'perdido'
  return estadoValidez(p, dias, ahora).vencido ? 'vencido' : 'abierto'
}

export interface Embudo {
  total: number
  confirmados: number
  perdidos: number
  vencidos: number
  abiertos: number
  /** Confirmados sobre los que ya se decidieron (sin los abiertos). null = ninguno decidido. */
  conversionPct: number | null
}

// `ventanaDias`: solo los creados en los últimos N días (null = todos).
export function embudo(
  todos: PresupuestoCierre[], dias: number, ahora: Date = new Date(), ventanaDias: number | null = null,
): Embudo {
  const ps = ventanaDias == null ? todos : todos.filter(p => ahora.getTime() - p.createdAt.getTime() <= ventanaDias * 24 * 3600 * 1000)
  const e = { total: ps.length, confirmados: 0, perdidos: 0, vencidos: 0, abiertos: 0 }
  for (const p of ps) {
    const c = cierreDe(p, dias, ahora)
    if (c === 'confirmado') e.confirmados++
    else if (c === 'perdido') e.perdidos++
    else if (c === 'vencido') e.vencidos++
    else e.abiertos++
  }
  const decididos = e.total - e.abiertos
  return { ...e, conversionPct: decididos > 0 ? (e.confirmados / decididos) * 100 : null }
}
