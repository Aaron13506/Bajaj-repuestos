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

export function leerCodigo(raw: string): Lectura {
  const s = raw.trim().toUpperCase()
  const m = s.match(/^([A-Z0-9]+)[^A-Z0-9]+(\d+)[^A-Z0-9].*$/)
  if (!m) return { codigo: s.replace(/[^A-Z0-9]/g, ''), cantidad: 1, raw }
  const n = Number(m[2])
  return { codigo: m[1], cantidad: Number.isInteger(n) && n > 0 ? n : 1, raw }
}
