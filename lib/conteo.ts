import type { BundlePiece } from './bundle'
import { etiquetaPieza, type SinEnviar } from './incidencias'
import type { Lectura } from './qr-bajaj'

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
  // Los otros códigos con que puede venir rotulada (doble SKU, lib/alt-sku.ts). Los llena la página.
  alternos: string[]
}

// Código o nombre comparable con lo leído o tecleado: mayúsculas, sin tildes ni separadores.
export const normCodigo = (s: string) => s.normalize('NFD').toUpperCase().replace(/[^A-Z0-9]/g, '')

// La fila contiene lo tecleado en su código, en un alterno o en el nombre.
export function coincideParcial(p: PiezaAContar, q: string): boolean {
  const n = normCodigo(q)
  return n !== '' && [p.codigo ?? '', ...p.alternos, p.nombre].some(s => normCodigo(s).includes(n))
}

// Qué fila de la caja corresponde a una lectura. Exacto por código o alterno; si no, la única
// fila cuyo código o nombre contiene lo tecleado. La búsqueda parcial solo vale para lo
// tecleado (`parcial`): una etiqueta escaneada trae el código entero o no es de esta caja.
export function resolverLectura(
  piezas: PiezaAContar[],
  lectura: Lectura,
  parcial = true,
): { pieza: PiezaAContar } | { ninguna: true } | { varias: PiezaAContar[] } {
  const c = lectura.codigo
  if (!c) return { ninguna: true }
  const uno = (xs: PiezaAContar[]) => (xs.length === 1 ? { pieza: xs[0] } : xs.length > 1 ? { varias: xs } : null)
  return uno(piezas.filter(p => p.codigo != null && normCodigo(p.codigo) === c))
    ?? uno(piezas.filter(p => p.alternos.some(a => normCodigo(a) === c)))
    ?? (parcial ? uno(piezas.filter(p => coincideParcial(p, c))) : null)
    ?? { ninguna: true }
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
    else m.set(clave, { clave, nombre, codigo, esperado: n - falta, sinEnviar: falta, alternos: [] })
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
