'use server'

import { db } from '@/lib/db'
import { applyMeasures, type MeasuresResult } from '@/lib/measures'
import { revalidatePath } from 'next/cache'
import { round2 } from '@/lib/parse'

// OJO: un módulo 'use server' solo puede exportar funciones async. Un `export type` acá se
// emite igual como re-export en runtime y REVIENTA la evaluación del módulo entero
// (`ReferenceError: MeasuresResult is not defined`) — con lo cual dejan de funcionar TODAS
// las server actions de las páginas que lo importan, no solo esta. El tipo se importa
// desde `@/lib/measures`, que es un módulo normal.

// Precio del conjunto: fija (o limpia) el precio de venta del ensamble como una
// unidad. Con `priceLocked` activo se usa como precio único al venderlo como conjunto
// en presupuestos, y ningún recálculo lo pisa. Sin precio o desmarcado, se libera.
export async function setBundlePrice(id: number, formData: FormData) {
  const priceStr = (formData.get('price') as string)?.trim() ?? ''
  const locked = formData.get('priceLocked') === 'true'
  const parsed = priceStr ? parseFloat(priceStr) : 0
  const price = isNaN(parsed) || parsed < 0 ? 0 : round2(parsed)

  await db.product.update({
    where: { id },
    data: { price, priceLocked: locked && price > 0 },
  })

  revalidatePath('/products')
  revalidatePath('/groups')
  revalidatePath(`/products/${id}`)
  revalidatePath('/presupuestos')
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