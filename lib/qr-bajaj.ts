// Lo que trae la etiqueta de una caja de Bajaj (QR) o de una bolsa reempacada (Code 128):
// SKU, cantidad y MRP, con separadores que cambian según quién la imprimió ('_' en Bajaj, '@'
// en el proveedor). Un lector USB o Bluetooth además escribe como teclado en inglés, y con
// el teclado del sistema en español '-1_842' llega como "'1?842". Por eso no se depende del
// carácter separador: el SKU es el primer tramo alfanumérico y la cantidad el siguiente
// tramo de dígitos. El MRP no se usa, pero se exige que haya un tercer tramo: sin él,
// "DH18 1135" tecleado con un espacio se leería como 1135 unidades de "DH18".

export type OrigenLectura = 'camara' | 'lector' | 'manual'

export interface Lectura {
  codigo: string     // sin separadores, en mayúsculas
  cantidad: number   // unidades en ese empaque; 1 si la etiqueta no la trae (tecleado a mano)
  raw: string
}

// Lo que trae una etiqueta: una pieza (caja o bolsa, arriba) o un estante del depósito ("UBI:A-3",
// docs/plan-inventario/05-ubicaciones-conteo.md). El prefijo UBI más un separador cualquiera es lo
// que distingue un estante: el mismo lector con el teclado en español manda "UBIÑA'3", y un SKU
// que empezara con UBI sigue con un dígito o letra, no con un separador.
export type Etiqueta = { tipo: 'ubicacion'; codigo: string; raw: string } | ({ tipo: 'pieza' } & Lectura)

export function leerEtiqueta(raw: string): Etiqueta {
  const s = raw.trim().toUpperCase()
  const u = s.match(/^UBI[^A-Z0-9](.*)$/)
  if (u) {
    const codigo = normUbicacion(u[1])
    if (codigo) return { tipo: 'ubicacion', codigo, raw }
  }
  const m = s.match(/^([A-Z0-9]+)[^A-Z0-9]+(\d+)[^A-Z0-9].*$/)
  if (!m) return { tipo: 'pieza', codigo: s.replace(/[^A-Z0-9]/g, ''), cantidad: 1, raw }
  const n = Number(m[2])
  return { tipo: 'pieza', codigo: m[1], cantidad: Number.isInteger(n) && n > 0 ? n : 1, raw }
}

// Un estante como se guarda en Product.ubicacion: mayúsculas, cada tramo de separadores es un
// guion ("a 3", "A'3" y "A-3" son el mismo). Vacío = sin ubicación.
export function normUbicacion(s: string): string | null {
  const n = s.normalize('NFD').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return n || null
}

export const UBICACION_MAX = 20
