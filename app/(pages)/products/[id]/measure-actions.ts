'use server'

import { db } from '@/lib/db'
import { applyMeasures, type MeasuresResult } from '@/lib/measures'
import { revalidatePath } from 'next/cache'
import { round2 } from '@/lib/parse'
import { fallo, ok, type ActionResult } from '@/lib/action-result'

// OJO: un módulo 'use server' solo puede exportar funciones async. Un `export type` acá se
// emite igual como re-export en runtime y REVIENTA la evaluación del módulo entero
// (`ReferenceError: MeasuresResult is not defined`) — con lo cual dejan de funcionar TODAS
// las server actions de las páginas que lo importan, no solo esta. El tipo se importa
// desde `@/lib/measures`, que es un módulo normal.

// Precio del conjunto: fija (o limpia) el precio de venta del ensamble como una
// unidad. Con `priceLocked` activo se usa como precio único al venderlo como conjunto
// en presupuestos, y ningún recálculo lo pisa. Sin precio o desmarcado, se libera.
//
// Un precio ilegible o negativo se rechaza: antes se guardaba como 0, que es "sin precio fijo",
// así que tipear mal borraba en silencio el precio que ya estaba cargado.
export async function setBundlePrice(id: number, formData: FormData): Promise<ActionResult> {
  const priceStr = (formData.get('price') as string)?.trim() ?? ''
  const locked = formData.get('priceLocked') === 'true'
  const parsed = priceStr ? parseFloat(priceStr) : 0
  if (isNaN(parsed) || parsed < 0) return fallo('El precio no es un número válido.')
  const price = round2(parsed)

  const r = await db.product.updateMany({
    where: { id },
    data: { price, priceLocked: locked && price > 0 },
  })
  if (r.count === 0) return fallo('Ese conjunto ya no existe. Recargá la página.')

  revalidatePath('/products')
  revalidatePath('/groups')
  revalidatePath(`/products/${id}`)
  revalidatePath('/presupuestos')
  return ok()
}

// Carga peso y dimensiones desde la respuesta de la IA. La lógica está en lib/measures
// porque el mismo formulario se usa desde la ficha del ensamble, desde un presupuesto y
// desde un envío; acá solo se resuelve QUÉ revalidar, que es lo único que cambia entre
// esas tres pantallas.
//
// `revalidate` (opcional, rutas separadas por coma) lo manda el formulario que invoca la
// acción: las medidas nuevas cambian el volumen y el landed de la pantalla desde la que
// se cargaron, y esa ruta no siempre es la del catálogo.
export async function updateMeasures(
  _prev: MeasuresResult,
  formData: FormData,
): Promise<MeasuresResult> {
  const result = await applyMeasures((formData.get('json') as string) ?? '')

  if (result.updated > 0) {
    revalidatePath('/products')
    revalidatePath('/envios')
    revalidatePath('/groups')
    // Ficha del ensamble desde donde se cargó (para ver los precios nuevos).
    const assemblyId = parseInt((formData.get('assemblyId') as string) ?? '')
    if (Number.isFinite(assemblyId)) revalidatePath(`/products/${assemblyId}`)

    for (const path of ((formData.get('revalidate') as string) ?? '').split(',')) {
      const clean = path.trim()
      if (clean.startsWith('/')) revalidatePath(clean)
    }
  }

  return result
}