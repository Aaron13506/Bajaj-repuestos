// ─────────────────────────────────────────────────────────────────────────────
// MOQ: cantidad mínima de compra
//
// Es un PISO, no un múltiplo: con un mínimo de 5 no se puede pedir 3, pero 7 sí — de ahí
// para arriba cualquier cantidad sirve. Por eso lo único que se valida es que la cantidad
// llegue al piso, y la corrección siempre es "subí hasta el mínimo", nunca "redondeá".
//
// Estas funciones avisan, no corrigen. La cantidad de una línea es una decisión de compra
// (¿me sirven 50 de esto o mejor saco la pieza?) y además mueve el volumen de la caja:
// subirla en silencio haría crecer el embarque sin que nadie lo haya decidido.
//
// Módulo aparte de lib/suppliers.ts a propósito: son funciones puras que también corren en
// el navegador (el armador del embarque las usa en vivo), y suppliers.ts importa la
// conexión a la base.
// ─────────────────────────────────────────────────────────────────────────────

/** ¿La cantidad llega al mínimo? Sin MOQ declarado no hay nada que validar. */
export function cumpleMoq(quantity: number, moq: number | null | undefined): boolean {
  if (!moq || moq <= 1) return true
  return quantity >= moq
}

/** La cantidad más chica que el proveedor acepta para esta pieza, dado lo que se quería. */
export function cantidadMinima(quantity: number, moq: number | null | undefined): number {
  if (!moq || moq <= 1) return quantity
  return Math.max(quantity, moq)
}
