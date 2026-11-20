// Conteo cíclico del depósito, reglas puras (docs/plan-inventario/05-ubicaciones-conteo.md). La
// base está en lib/conteo-inventario-db.ts; esto lo comparten la pantalla (que avisa y apaga el
// botón) y el cierre (el candado real), y lo prueba check:costeo.

export interface FilaCierreConteo {
  productId: number
  /** Product.stock al abrir: solo para mostrar. */
  sistema: number
  /** Vacío = sin contar (no se ajusta); 0 = la busqué y no está. */
  contado: number | null
  /** Product.stock al cerrar: contra esto se ajusta. */
  stockAhora: number
  /** Tuvo movimientos de stock desde que se abrió el conteo (una venta en el medio). */
  movidaDurante: boolean
}

// Lo que hay que ajustar: contra el stock al CERRAR, no contra la foto al abrir. Si en el medio se
// vendió una, el stock ya la descontó y el conteo (hecho después) tampoco la ve: no hay diferencia.
export const difConteo = (f: Pick<FilaCierreConteo, 'contado' | 'stockAhora'>): number | null =>
  f.contado == null ? null : f.contado - f.stockAhora

// Una diferencia grande pide nota: 3 o más unidades, o no encontrar nada de lo que el sistema dice
// que hay. El umbral se ajusta en el depósito.
export const NOTA_DESDE = 3
export const pideNota = (f: Pick<FilaCierreConteo, 'contado' | 'stockAhora'>): boolean => {
  const d = difConteo(f)
  return d != null && (Math.abs(d) >= NOTA_DESDE || (f.contado === 0 && f.stockAhora > 0))
}

export function planCierreConteo(filas: FilaCierreConteo[]) {
  const contadas = filas.filter(f => f.contado != null)
  return {
    ajustes: contadas.flatMap(f => { const d = difConteo(f)!; return d === 0 ? [] : [{ productId: f.productId, cantidad: d }] }),
    contadas: contadas.map(f => f.productId),
    // Las que se movieron mientras se contaba: la pantalla avisa antes de cerrar (pudo contarse
    // antes o después de la venta).
    movidas: contadas.filter(f => f.movidaDurante).map(f => f.productId),
    pideNota: contadas.some(pideNota),
  }
}

/** Por qué no se puede cerrar, o null. */
export function motivoNoCierraConteo(filas: FilaCierreConteo[], notas: string | null): string | null {
  const plan = planCierreConteo(filas)
  if (plan.contadas.length === 0) return 'No contaste nada todavía.'
  if (plan.pideNota && !notas?.trim()) return `Hay diferencias grandes (${NOTA_DESDE} o más, o no estaba nada): escribí una nota que diga qué pasó.`
  return null
}

// ── Qué contar ───────────────────────────────────────────────────────────────────────────────

export const DIAS_VENCE_CONTEO = 60
export const DIAS_RECIENTES = 30

export interface CandidataConteo {
  stock: number
  contadoAt: Date | null
  /** Movimientos (sin contar los de conteo) desde el último conteo, en los últimos DIAS_RECIENTES. */
  movimientos: number
  /** De esos, ajustes a mano. */
  ajustes: number
}

// Por qué conviene contar esta pieza (y cuánto pesa para ordenar), o null. Lo que más se mueve es
// lo que más se desajusta; un ajuste a mano es la señal más fuerte. shortcut: falta "una venta falló
// por stock" porque ese rechazo no se guarda en ningún lado; se suma si se empieza a registrar.
export function sugerirConteo(p: CandidataConteo, ahora: Date): { motivo: string; peso: number } | null {
  if (p.ajustes > 0) return { motivo: p.ajustes === 1 ? 'ajuste a mano reciente' : `${p.ajustes} ajustes a mano recientes`, peso: 300 + p.movimientos }
  if (p.movimientos > 0) return { motivo: p.movimientos === 1 ? '1 movimiento desde el último conteo' : `${p.movimientos} movimientos desde el último conteo`, peso: 200 + p.movimientos }
  if (p.stock <= 0) return null
  if (p.contadoAt == null) return { motivo: 'nunca contada', peso: 150 }
  const dias = Math.floor((ahora.getTime() - p.contadoAt.getTime()) / 86_400_000)
  return dias > DIAS_VENCE_CONTEO ? { motivo: `contada hace ${dias} días`, peso: 100 + Math.min(dias, 999) / 1000 } : null
}
