'use server'

import { db } from '@/lib/db'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { findOrCreateCliente, isUniqueViolation, revalidateClientes } from '@/lib/clientes'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { telefonoIntl } from '@/lib/utils'

export async function createCliente(formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return fallo('Escribí el nombre del cliente.')
  const telefono = (formData.get('telefono') as string)?.trim() || null

  const { cliente, created } = await findOrCreateCliente(nombre, telefono)
  revalidateClientes()
  // Si ya existía no se crea un duplicado, pero hay que decirlo: antes el form se
  // limpiaba y parecía que había agregado algo.
  if (!created) redirect(`/clientes?existe=${cliente.id}`)
  // Mismo número con otro nombre suele ser la misma persona cargada dos veces: se crea igual
  // (puede ser un familiar), pero se avisa.
  const intl = telefonoIntl(telefono)
  if (intl) {
    const otros = await db.cliente.findMany({ where: { id: { not: cliente.id }, telefono: { not: null } }, select: { id: true, telefono: true } })
    const mismo = otros.find(o => telefonoIntl(o.telefono) === intl)
    if (mismo) redirect(`/clientes?mismoTel=${mismo.id}`)
  }
  return ok()
}

export async function updateCliente(id: number, formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return fallo('Escribí el nombre del cliente.')
  const telefono = (formData.get('telefono') as string)?.trim() || null
  const notas = (formData.get('notas') as string)?.trim() || null

  try {
    await db.cliente.update({ where: { id }, data: { nombre, telefono, notas } })
  } catch (e) {
    // Renombrar a un nombre ya tomado avisa en la ficha en vez de tirar un 500.
    if (isUniqueViolation(e)) redirect(`/clientes/${id}?nombreTomado=1`)
    throw e
  }
  revalidateClientes()
  redirect(`/clientes/${id}`)
}

export async function deleteCliente(id: number) {
  // Los pedidos quedan con clienteId -> null por onDelete: SetNull, sin perder historial.
  await db.cliente.delete({ where: { id } })
  revalidateClientes()
  redirect('/clientes')
}

// ─── Lista de espera ─────────────────────────────────────────────────────────
function revalidarEsperas() {
  revalidateClientes()
  revalidatePath('/products/[id]', 'page')
  revalidatePath('/esperas')
  revalidatePath('/')
}

// Anota que el cliente espera esta pieza. Si no existe se crea (como en el armador); si ya la
// esperaba, solo se actualiza la nota y conserva su lugar en la fila.
export async function agregarEspera(productId: number, formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return fallo('Escribí el nombre del cliente.')
  const nota = (formData.get('nota') as string)?.trim() || null
  return anotarEspera(nombre, productId, nota)
}

// Desde /esperas/new: un cliente y las piezas que espera, elegidas en el buscador del catálogo.
export async function agregarEsperas(formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return fallo('Escribí el nombre del cliente.')
  let ids: unknown
  try { ids = JSON.parse(String(formData.get('productIds') ?? '[]')) } catch { ids = null }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger)) return fallo('Agregá al menos una pieza.')
  const unicos = [...new Set(ids as number[])]
  if (await db.product.count({ where: { id: { in: unicos } } }) !== unicos.length) return fallo('Alguna pieza ya no está en el catálogo. Recargá la página.')
  const nota = (formData.get('nota') as string)?.trim() || null

  const { cliente } = await findOrCreateCliente(nombre)
  await db.$transaction(unicos.map(productId => db.espera.upsert({
    where: { clienteId_productId: { clienteId: cliente.id, productId } },
    create: { clienteId: cliente.id, productId, nota },
    update: { nota },
  })))
  revalidarEsperas()
  redirect('/esperas')
}

async function anotarEspera(nombre: string, productId: number, nota: string | null): Promise<ActionResult> {
  const { cliente } = await findOrCreateCliente(nombre)
  await db.espera.upsert({
    where: { clienteId_productId: { clienteId: cliente.id, productId } },
    create: { clienteId: cliente.id, productId, nota },
    update: { nota },
  })
  revalidarEsperas()
  return ok()
}

// Ya se le avisó o ya no la quiere: sale de la lista. deleteMany para que un doble clic no falle.
export async function quitarEspera(id: number): Promise<ActionResult> {
  await db.espera.deleteMany({ where: { id } })
  revalidarEsperas()
  return ok()
}
