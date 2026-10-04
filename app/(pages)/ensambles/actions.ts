'use server'

import { db } from '@/lib/db'
import { compatibleModelsFrom } from '@/lib/modelo'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { motivoEnsambleEnUso } from '@/lib/producto-en-uso'

// Un ensamble es identidad y nada más: nombre, moto y de dónde salió. No tiene precio, peso,
// medidas ni stock (ver el modelo Ensamble), así que no hay nada que costear acá.
function leerFormulario(formData: FormData, modelosActuales: string | null = null) {
  return {
    // El nombre en inglés es el obligatorio (el del catálogo); el de español es opcional.
    nameEs: ((formData.get('nameEs') as string | null) ?? '').trim() || null,
    nameEn: ((formData.get('nameEn') as string | null) ?? '').trim(),
    sourceUrl: ((formData.get('sourceUrl') as string | null) ?? '').trim() || null,
    compatibleModels: compatibleModelsFrom(formData.getAll('models'), modelosActuales),
  }
}

// `sourceUrl` es única: la misma página de 99rpm no puede ser dos ensambles.
async function guardar<T>(escribir: () => Promise<T>): Promise<{ ok: true; valor: T } | { ok: false; error: string }> {
  try {
    return { ok: true, valor: await escribir() }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return fallo('Ya hay un ensamble con esa URL fuente.')
    }
    throw e
  }
}

export async function crearEnsamble(formData: FormData): Promise<ActionResult> {
  const { compatibleModels, ...data } = leerFormulario(formData)
  if (!data.nameEn) return fallo('El nombre en inglés es obligatorio.')
  // La moto es lo único que distingue dos ensambles homónimos, y la columna no admite vacío.
  if (!compatibleModels) return fallo('Elegí al menos una moto.')

  const r = await guardar(() => db.ensamble.create({ data: { ...data, compatibleModels }, select: { id: true } }))
  if (!r.ok) return r

  revalidatePath('/groups')
  redirect(`/ensambles/${r.valor.id}`)
}

export async function actualizarEnsamble(id: number, formData: FormData): Promise<ActionResult> {
  const actual = await db.ensamble.findUnique({ where: { id }, select: { compatibleModels: true } })
  if (!actual) return fallo('Ese ensamble ya no existe.')

  const { compatibleModels, ...data } = leerFormulario(formData, actual.compatibleModels)
  if (!data.nameEn) return fallo('El nombre en inglés es obligatorio.')
  if (!compatibleModels) return fallo('Elegí al menos una moto.')

  const r = await guardar(() => db.ensamble.update({ where: { id }, data: { ...data, compatibleModels } }))
  if (!r.ok) return r

  revalidatePath('/groups')
  revalidatePath('/products')
  revalidatePath(`/ensambles/${id}`)
  redirect(`/ensambles/${id}`)
}

// Un ensamble vendido en algún pedido no se borra (ver motivoEnsambleEnUso): la FK es Restrict,
// y sin contar primero la negativa llegaba como un P2003 crudo. Los enlaces a sus piezas se van
// con él (cascada) y las piezas quedan sueltas. `volver` es para el botón de la ficha: borrado
// el ensamble, esa URL ya es un 404, así que hay que llevar al listado.
export async function eliminarEnsamble(id: number, volver = false): Promise<ActionResult> {
  const e = await db.ensamble.findUnique({
    where: { id },
    select: { _count: { select: { pedidoItems: true } } },
  })
  // Ya lo había borrado otra request: el estado que se quería es el que hay.
  if (e) {
    const motivo = motivoEnsambleEnUso(e._count)
    if (motivo) return fallo(`No se puede borrar. ${motivo}`)
    try {
      await db.ensamble.delete({ where: { id } })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'P2003') return fallo('No se puede borrar: otra parte del sistema todavía usa este ensamble.')
      if (code !== 'P2025') throw err
    }
  }
  revalidatePath('/groups')
  revalidatePath('/products')
  if (volver) redirect('/groups')
  return ok()
}
