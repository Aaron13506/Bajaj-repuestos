// Cuánto tarda de verdad cada tramo (puro, sin DB).
//
// `PedidoItem.shippingStatusAt` solo guardaba la fecha del ÚLTIMO cambio, así que no había
// forma de saber cuánto tarda India → Caracas, que es justo lo que se le promete al cliente.
// Cada cambio de etapa deja ahora su fila (`PedidoItemEtapa`) y de esas filas salen los tiempos.
//
// Un tramo es el paso de una etapa a la siguiente que SE RECORRIÓ: lo que tardó entre llegar a
// una y llegar a la otra. Si alguien salta etapas (de 'pendiente' a 'en_usa') el tramo es ese
// salto, no se inventan las intermedias. Un retroceso (se corrigió un error) corta la cuenta de
// esa línea: lo que vino antes del retroceso no se mide contra lo de después.
import { statusIndex } from '@/lib/shipping-status'

export interface EventoEtapa {
  itemId: number
  desde: string
  hacia: string
  at: Date
}

export interface TramoStat {
  /** "camino_usa→en_usa". */
  tramo: string
  desde: string
  hacia: string
  n: number
  promedioDias: number
  medianaDias: number
  minDias: number
  maxDias: number
}

const DIA_MS = 24 * 3600 * 1000
const round1 = (n: number) => Math.round(n * 10) / 10

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function resumir(clave: string, desde: string, hacia: string, dias: number[]): TramoStat {
  return {
    tramo: clave, desde, hacia, n: dias.length,
    promedioDias: round1(dias.reduce((s, d) => s + d, 0) / dias.length),
    medianaDias: round1(mediana(dias)),
    minDias: round1(Math.min(...dias)),
    maxDias: round1(Math.max(...dias)),
  }
}

// Los pares de etapas consecutivas de cada línea, con cuántos días pasaron entre uno y otro.
export function tramosRecorridos(eventos: EventoEtapa[]): { itemId: number; desde: string; hacia: string; dias: number }[] {
  const porItem = new Map<number, EventoEtapa[]>()
  for (const e of eventos) {
    const l = porItem.get(e.itemId) ?? []
    l.push(e)
    porItem.set(e.itemId, l)
  }
  const out: { itemId: number; desde: string; hacia: string; dias: number }[] = []
  for (const [itemId, evs] of porItem) {
    evs.sort((a, b) => a.at.getTime() - b.at.getTime())
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1]
      const cur = evs[i]
      // Solo hacia adelante y encadenado: lo que llegó a `prev.hacia` es lo que sale de ahí.
      if (cur.desde !== prev.hacia) continue
      if (statusIndex(cur.hacia) <= statusIndex(prev.hacia)) continue
      out.push({ itemId, desde: prev.hacia, hacia: cur.hacia, dias: (cur.at.getTime() - prev.at.getTime()) / DIA_MS })
    }
  }
  return out
}

// Estadística por tramo, en el orden del recorrido.
export function tiemposPorTramo(eventos: EventoEtapa[]): TramoStat[] {
  const grupos = new Map<string, { desde: string; hacia: string; dias: number[] }>()
  for (const t of tramosRecorridos(eventos)) {
    const k = `${t.desde}→${t.hacia}`
    const g = grupos.get(k) ?? { desde: t.desde, hacia: t.hacia, dias: [] }
    g.dias.push(t.dias)
    grupos.set(k, g)
  }
  return [...grupos.entries()]
    .map(([k, g]) => resumir(k, g.desde, g.hacia, g.dias))
    .sort((a, b) => statusIndex(a.desde) - statusIndex(b.desde) || statusIndex(a.hacia) - statusIndex(b.hacia))
}

// De que se compró (salió de 'pendiente') a que llegó a `meta`: el número que se le promete al
// cliente. Se mide por línea, de la primera salida de 'pendiente' a la primera vez que llegó a
// la meta (o más allá), y solo cuenta las líneas que ya llegaron.
export function tiempoDeCompraA(eventos: EventoEtapa[], meta: string): TramoStat | null {
  const metaIdx = statusIndex(meta)
  const porItem = new Map<number, EventoEtapa[]>()
  for (const e of eventos) {
    const l = porItem.get(e.itemId) ?? []
    l.push(e)
    porItem.set(e.itemId, l)
  }
  const dias: number[] = []
  for (const evs of porItem.values()) {
    evs.sort((a, b) => a.at.getTime() - b.at.getTime())
    const salida = evs.find(e => e.desde === 'pendiente')
    const llegada = evs.find(e => statusIndex(e.hacia) >= metaIdx)
    if (!salida || !llegada || llegada.at.getTime() < salida.at.getTime()) continue
    dias.push((llegada.at.getTime() - salida.at.getTime()) / DIA_MS)
  }
  return dias.length > 0 ? resumir(`compra→${meta}`, 'pendiente', meta, dias) : null
}

export type RutaTiempo = 'express_directo' | 'express_usa' | 'aereo' | 'maritimo_cbm'

export interface ResumenTiempoRuta {
  ruta: RutaTiempo
  label: string
  /** De compra a en_venezuela (o de creación a llegada/recepción en marítimo). */
  total: TramoStat | null
  /** Desglose por tramo intermedio (vacío en marítimo). */
  tramos: TramoStat[]
}

const RUTAS_ORDEN: { ruta: RutaTiempo; label: string }[] = [
  { ruta: 'express_directo', label: 'Express directo' },
  { ruta: 'express_usa', label: 'Express por USA' },
  { ruta: 'aereo', label: 'Aéreo (vía USA)' },
  { ruta: 'maritimo_cbm', label: 'Marítimo' },
]

export function rutaTiempoDeEnvio(envio: { modo: string; reenvio: string }): RutaTiempo {
  if (envio.modo === 'maritimo_cbm') return 'maritimo_cbm'
  if (envio.modo === 'express' && envio.reenvio === 'por_kilo') return 'express_usa'
  if (envio.modo === 'express') return 'express_directo'
  return 'aereo'
}

export function tiemposPorRuta(
  eventos: (EventoEtapa & { ruta: Exclude<RutaTiempo, 'maritimo_cbm'> })[],
  embarquesMaritimos: { createdAt: Date; llegadaAt: Date | null; entregadoAt: Date | null }[] = [],
): ResumenTiempoRuta[] {
  const porRuta = new Map<Exclude<RutaTiempo, 'maritimo_cbm'>, EventoEtapa[]>()
  for (const e of eventos) {
    const l = porRuta.get(e.ruta) ?? []
    l.push(e)
    porRuta.set(e.ruta, l)
  }

  const out: ResumenTiempoRuta[] = []
  for (const { ruta, label } of RUTAS_ORDEN) {
    if (ruta === 'maritimo_cbm') {
      const dias: number[] = []
      for (const emb of embarquesMaritimos) {
        const fin = emb.llegadaAt ?? emb.entregadoAt
        if (!fin || fin.getTime() <= emb.createdAt.getTime()) continue
        dias.push((fin.getTime() - emb.createdAt.getTime()) / DIA_MS)
      }
      if (dias.length > 0) {
        out.push({
          ruta,
          label,
          total: resumir('maritimo→llegada', 'creado', 'en_venezuela', dias),
          tramos: [],
        })
      }
      continue
    }
    const evs = porRuta.get(ruta)
    if (!evs || evs.length === 0) continue
    const total = tiempoDeCompraA(evs, 'en_venezuela')
    const tramos = tiemposPorTramo(evs)
    if (total !== null || tramos.length > 0) {
      out.push({ ruta, label, total, tramos })
    }
  }
  return out
}

// ── Cajas paradas ──────────────────────────────────────────────────────────────────────────────
//
// Una caja en viaje cuyas líneas no cambian de etapa hace días es la que hay que ir a preguntar
// (al proveedor, a Shoppre, al courier). Se mide desde el último cambio de cualquiera de sus
// líneas; una caja con todo entregado ya terminó.
// shortcut: umbral fijo; cuando el historial (tiemposPorTramo) junte suficientes tramos, comparar
// contra lo que tarda de verdad cada tramo.
export const DIAS_CAJA_PARADA = 14

export function diasSinMoverse(
  lineas: { shippingStatus: string; shippingStatusAt: Date | null }[],
  ahora: Date = new Date(),
): number | null {
  const enCurso = lineas.filter(l => l.shippingStatus !== 'entregado')
  if (enCurso.length === 0) return null
  const fechas = lineas.flatMap(l => (l.shippingStatusAt ? [l.shippingStatusAt.getTime()] : []))
  if (fechas.length === 0) return null
  return Math.floor((ahora.getTime() - Math.max(...fechas)) / (24 * 3600 * 1000))
}
