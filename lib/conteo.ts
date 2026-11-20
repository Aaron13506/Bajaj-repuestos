import type { Lectura } from './qr-bajaj'

// Una fila de la mesa de conteo, para resolver lecturas contra ella. La arma la recepción
// (RecepcionLinea) con los alternos de cada código (doble SKU, lib/alt-sku.ts).
export interface PiezaAContar {
  clave: string
  nombre: string
  codigo: string | null
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
export function resolverLectura<T extends PiezaAContar>(
  piezas: T[],
  lectura: Lectura,
  parcial = true,
): { pieza: T } | { ninguna: true } | { varias: T[] } {
  const c = lectura.codigo
  if (!c) return { ninguna: true }
  const uno = (xs: T[]) => (xs.length === 1 ? { pieza: xs[0] } : xs.length > 1 ? { varias: xs } : null)
  return uno(piezas.filter(p => p.codigo != null && normCodigo(p.codigo) === c))
    ?? uno(piezas.filter(p => p.alternos.some(a => normCodigo(a) === c)))
    ?? (parcial ? uno(piezas.filter(p => coincideParcial(p, c))) : null)
    ?? { ninguna: true }
}
