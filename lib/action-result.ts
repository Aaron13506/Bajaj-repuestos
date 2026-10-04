// Lo que devuelve una server action que puede fallar por una razón que el usuario tiene que
// leer. Un `return` mudo en una acción de form se interpreta, del lado del cliente, como
// éxito (cierra el modal, limpia el formulario) y el dato no se guardó; un `throw` en
// producción llega como un mensaje genérico, porque Next oculta el texto del error.
// Devolver el resultado es la única forma de que el mensaje llegue entero.
export type ActionResult = { ok: true } | { ok: false; error: string }

// Un fallo que el usuario tiene que leer y que no es un bug: una regla de negocio que dijo
// que no ("ya está confirmado", "pieza descontinuada"). Sirve para cortar desde adentro de
// un helper o de una transacción sin tener que ir devolviendo el resultado capa por capa, y
// `conErrorDeNegocio` lo convierte en `{ ok: false }` en el borde de la acción. Cualquier otro
// error —un bug, la base caída— NO se captura: tiene que seguir siendo ruidoso.
export class ErrorDeNegocio extends Error {}

export const ok = (): ActionResult => ({ ok: true })
// Tipo estrecho a propósito: así sirve también dentro de uniones más ricas (ver
// ResultadoCompra en lib/movimientos.ts), no solo donde se espera un ActionResult.
export const fallo = (error: string) => ({ ok: false as const, error })

/**
 * Corre el cuerpo de una acción y devuelve su resultado. Un `redirect()` de adentro (que en
 * Next es una excepción) pasa de largo: solo se atrapa `ErrorDeNegocio`.
 */
export async function conErrorDeNegocio(cuerpo: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await cuerpo()
    return ok()
  } catch (e) {
    if (e instanceof ErrorDeNegocio) return fallo(e.message)
    throw e
  }
}
