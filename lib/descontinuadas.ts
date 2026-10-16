import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import type { RefLinea } from '@/lib/linea-pedido'

/**
 * Corta si alguna línea es una pieza que Bajaj dejó de fabricar.
 *
 * El armador ya las bloquea en pantalla, pero eso no alcanza: la pieza pudo marcarse
 * DESPUÉS de que el presupuesto se guardó, y al reabrirlo para tocar una cantidad se
 * reescribiría igual. Es la misma razón por la que el embarque marítimo corta en
 * `sincronizarLineas` — el bloqueo es una regla del negocio, no un detalle de la pantalla.
 *
 * Acá pesa más que en un embarque: un embarque es mercancía propia y se saca sin costo,
 * un presupuesto es un compromiso con un cliente y suele tener el 50% cobrado de seña.
 *
 * Tira un `ErrorDeNegocio`, que `createPresupuesto`/`updatePresupuesto` devuelven como
 * `{ ok: false, error }`: un `Error` pelado llega al navegador en producción como "An error
 * occurred in the Server Components render", sin el texto. Es el último cerrojo, no la vía
 * normal de enterarse: lo normal es verlas tachadas en el armador. Que falle es preferible a
 * guardar la promesa.
 */
export async function bloquearDescontinuadas(items: RefLinea[]) {
  // Solo las piezas sueltas: un conjunto no es una pieza y no tiene `discontinuedAt`.
  const ids = [...new Set(items.flatMap(i => (i.productId != null ? [i.productId] : [])))]
  if (ids.length === 0) return
  const nls = await db.product.findMany({
    where: { id: { in: ids }, discontinuedAt: { not: null } },
    select: { nameEs: true, bajajCode: true },
  })
  if (nls.length === 0) return
  const lista = nls.map(p => p.bajajCode ?? p.nameEs).join(', ')
  const una = nls.length === 1
  throw new ErrorDeNegocio(
    `No se puede guardar: ${nls.length} pieza${una ? '' : 's'} descontinuada${una ? '' : 's'} (${lista}). ` +
    `Bajaj no ${una ? 'la fabrica' : 'las fabrica'} más y no ${una ? 'la consigue' : 'las consigue'} ningún ` +
    `proveedor, así que cotizar${una ? 'la' : 'las'} es prometer algo que no se va a poder comprar. ` +
    `Sacá${una ? 'la' : 'las'} del presupuesto.`
  )
}
