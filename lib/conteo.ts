import type { BundlePiece } from './bundle'
import { etiquetaPieza, type SinEnviar } from './incidencias'

// Lo que se cuenta al abrir una caja: piezas físicas, no líneas. Un conjunto se abre en sus
// piezas y la misma pieza en dos pedidos (o dos subgrupos) se suma en una fila, porque en la
// mesa se cuenta por código, no por cliente.
export interface PiezaAContar {
  clave: string
  nombre: string
  codigo: string | null
  esperado: number
  // Unidades que el proveedor no mandó (incidencias "sin_enviar" abiertas): ya restadas de
  // `esperado`, se muestran aparte para que un 0 en la mesa no parezca un faltante.
  sinEnviar: number
  // Pieza del catálogo con peso y medidas todavía estimados: al tenerla en la mano se puede
  // pesar (opcional). Lo adjunta la página; null = ya medida o sin producto único.
  estimada?: { productId: number; weightGrams: number | null; dimL: number | null; dimA: number | null; dimH: number | null } | null
}

export function piezasAContar(
  lineas: { nombre: string; codigo: string | null; quantity: number; piezas: BundlePiece[]; sinEnviar?: SinEnviar }[],
): PiezaAContar[] {
  const m = new Map<string, PiezaAContar>()
  const sumar = (nombre: string, codigo: string | null, n: number, noVino: number) => {
    const clave = codigo ?? nombre
    const falta = Math.min(n, noVino)
    const p = m.get(clave)
    if (p) { p.esperado += n - falta; p.sinEnviar += falta }
    else m.set(clave, { clave, nombre, codigo, esperado: n - falta, sinEnviar: falta })
  }
  for (const l of lineas) {
    const sets = Math.min(l.quantity, l.sinEnviar?.lineaEntera ?? 0)
    if (l.piezas.length === 0) sumar(l.nombre, l.codigo, l.quantity, sets)
    else for (const p of l.piezas) {
      sumar(p.nameEs, p.bajajCode, p.quantity * l.quantity, p.quantity * sets + (l.sinEnviar?.porPieza.get(etiquetaPieza(p)) ?? 0))
    }
  }
  return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre))
}
