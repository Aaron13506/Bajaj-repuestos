// Las cajas físicas de un envío, como las pesó y midió el transportista o el depósito.
//
// Una entrega llega al depósito en varios paquetes (el proveedor despacha en dos o tres), y el
// depósito puede reempacarlos en otras cajas antes de mandarlos. Para la trazabilidad se anota
// lo que LLEGÓ y, si hubo reempaque, lo que SALE. Para el costeo cuenta lo que sale: es lo que
// el transportista pesa, mide y factura, caja por caja.
//
// Vacío es "no se sabe todavía", nunca cero: una caja anotada con su referencia y sin pesar
// sigue sirviendo para ubicarla, y no entra a la cuenta como 0 kg.

import { CM3_PER_M3, type MedidasCaja } from './calc'

export const ETAPAS_CAJA = ['llegada', 'salida'] as const
export type EtapaCaja = (typeof ETAPAS_CAJA)[number]

export const MAX_CAJAS_POR_ETAPA = 20
// Una referencia (ID del paquete en el depósito, tracking) no pasa de unas decenas de caracteres.
const MAX_REFERENCIA = 80

export const ETAPA_CAJA_META: Record<EtapaCaja, { label: string; corto: string }> = {
  llegada: { label: 'Lo que llegó al depósito', corto: 'llegó' },
  salida: { label: 'Lo que sale después del reempaque', corto: 'sale' },
}

export function esEtapaCaja(v: unknown): v is EtapaCaja {
  return typeof v === 'string' && (ETAPAS_CAJA as readonly string[]).includes(v)
}

export interface CajaFisica {
  referencia: string | null
  pesoKg: number | null
  largoCm: number | null
  anchoCm: number | null
  altoCm: number | null
}

export type CampoCaja = 'referencia' | 'peso' | 'largo' | 'ancho' | 'alto'

// Un número del formulario. Vacío o 0 = sin dato (null). Ilegible o negativo = error: vacío
// reemplaza lo que había, así que un "18,6x" mal tipeado borraría en silencio un peso cargado.
function numeroCaja(raw: string | undefined): number | null | 'error' {
  const t = (raw ?? '').trim()
  if (!t) return null
  const v = Number(t.replace(',', '.'))
  if (!Number.isFinite(v) || v < 0) return 'error'
  return v > 0 ? v : null
}

/**
 * Las cajas de una etapa tal como llegan del formulario (listas paralelas por campo). Un
 * renglón vacío se descarta; uno con algo escrito se guarda aunque falten datos (una caja
 * sin pesar sigue siendo trazabilidad). Las medidas van las tres o ninguna: dos de tres no
 * dan volumen y casi siempre son un dato que se olvidó.
 */
export function leerCajasEtapa(
  etapa: EtapaCaja,
  campos: Record<CampoCaja, string[]>,
): { filas: CajaFisica[] } | { error: string } {
  const label = ETAPA_CAJA_META[etapa].label
  const n = Math.max(...Object.values(campos).map(l => l.length), 0)
  const filas: CajaFisica[] = []
  for (let i = 0; i < n; i++) {
    const referencia = (campos.referencia[i] ?? '').trim() || null
    const crudos = { peso: campos.peso[i], largo: campos.largo[i], ancho: campos.ancho[i], alto: campos.alto[i] }
    if (!referencia && Object.values(crudos).every(v => !(v ?? '').trim())) continue
    const caja = `${label}, caja ${filas.length + 1}`
    if ((referencia?.length ?? 0) > MAX_REFERENCIA) return { error: `${caja}: la referencia pasa de ${MAX_REFERENCIA} caracteres.` }
    const nombres = { peso: 'el peso', largo: 'el largo', ancho: 'el ancho', alto: 'el alto' } as const
    const v = {} as Record<keyof typeof crudos, number | null>
    for (const k of Object.keys(crudos) as (keyof typeof crudos)[]) {
      const x = numeroCaja(crudos[k])
      if (x === 'error') return { error: `${caja}: revisá ${nombres[k]}, no es un número válido.` }
      v[k] = x
    }
    const dims = [v.largo, v.ancho, v.alto].filter(d => d != null).length
    if (dims > 0 && dims < 3) return { error: `${caja}: cargá las tres medidas (largo, ancho y alto) o ninguna.` }
    filas.push({ referencia, pesoKg: v.peso, largoCm: v.largo, anchoCm: v.ancho, altoCm: v.alto })
  }
  if (filas.length > MAX_CAJAS_POR_ETAPA) return { error: `${label}: máximo ${MAX_CAJAS_POR_ETAPA} cajas.` }
  return { filas }
}

/**
 * Qué cajas se facturan. Con reempaque, las de salida; si todavía no se cargaron, las de
 * llegada como provisorias (son la misma mercancía medida de verdad, mejor que la suma de las
 * piezas, que es un piso) y la pantalla lo dice. Sin reempaque, las que llegaron son las que viajan.
 */
export function cajasQueSeFacturan<T extends { etapa: string }>(
  reempaque: boolean,
  cajas: T[],
): { etapa: EtapaCaja; cajas: T[]; provisoria: boolean } {
  const llegada = cajas.filter(c => c.etapa === 'llegada')
  if (!reempaque) return { etapa: 'llegada', cajas: llegada, provisoria: false }
  const salida = cajas.filter(c => c.etapa === 'salida')
  if (salida.length > 0) return { etapa: 'salida', cajas: salida, provisoria: false }
  return { etapa: 'llegada', cajas: llegada, provisoria: llegada.length > 0 }
}

/** Lo que calcEnvio necesita de cada caja. */
export function medidasDeCajas(cajas: CajaFisica[]): MedidasCaja[] {
  return cajas.map(c => ({ pesoKg: c.pesoKg, dimL: c.largoCm, dimA: c.anchoCm, dimH: c.altoCm }))
}

export interface ResumenCajas {
  cajas: number
  /** Suma de los pesos, solo si TODAS están pesadas; si falta una, el total no se sabe. */
  pesoKg: number | null
  /** Volumen total en m³, solo si todas están medidas. */
  volumenM3: number | null
  /** Volumétrico total (cada caja con el divisor), solo si todas están medidas. */
  volumetricoKg: number | null
  /** Suma de max(peso, volumétrico) caja por caja: así cobra el depósito. Solo con todo cargado. */
  cobrableKg: number | null
  sinPeso: number
  sinMedidas: number
}

const cm3De = (c: CajaFisica) => (c.largoCm && c.anchoCm && c.altoCm ? c.largoCm * c.anchoCm * c.altoCm : null)

export function resumenCajas(cajas: CajaFisica[], divisor: number): ResumenCajas {
  const pesos = cajas.map(c => c.pesoKg)
  const vols = cajas.map(cm3De)
  const sinPeso = pesos.filter(p => p == null).length
  const sinMedidas = vols.filter(v => v == null).length
  const hay = cajas.length > 0
  const pesoKg = hay && sinPeso === 0 ? pesos.reduce((s, p) => s! + p!, 0)! : null
  const cm3 = hay && sinMedidas === 0 ? vols.reduce((s, v) => s! + v!, 0)! : null
  return {
    cajas: cajas.length,
    pesoKg,
    volumenM3: cm3 != null ? cm3 / CM3_PER_M3 : null,
    volumetricoKg: cm3 != null ? cm3 / divisor : null,
    cobrableKg: pesoKg != null && cm3 != null
      ? cajas.reduce((s, _, i) => s + Math.max(pesos[i]!, vols[i]! / divisor), 0)
      : null,
    sinPeso,
    sinMedidas,
  }
}

// Lo que se lee de cada EnvioCaja. Lo comparten la ficha y el costeo de la lista, el
// inventario y los resultados (lib/costo-envios.ts): tienen que dar el mismo número.
export const CAJA_SELECT = {
  id: true, etapa: true, referencia: true, pesoKg: true, largoCm: true, anchoCm: true, altoCm: true,
} as const

export function cajaFisica(c: {
  etapa: string
  referencia: string | null
  pesoKg: { toString(): string } | null
  largoCm: number | null
  anchoCm: number | null
  altoCm: number | null
}): CajaFisica & { etapa: string } {
  return {
    etapa: c.etapa,
    referencia: c.referencia,
    pesoKg: c.pesoKg != null ? parseFloat(c.pesoKg.toString()) : null,
    largoCm: c.largoCm,
    anchoCm: c.anchoCm,
    altoCm: c.altoCm,
  }
}
