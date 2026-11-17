'use server'

import { db } from '@/lib/db'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { findClienteByNombre, findOrCreateCliente, isUniqueViolation, revalidateClientes } from '@/lib/clientes'
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
  const c = await clienteDeEspera(formData)
  if (typeof c === 'string') return fallo(c)
  const nota = (formData.get('nota') as string)?.trim() || null
  await db.espera.upsert({
    where: { clienteId_productId: { clienteId: c.id, productId } },
    create: { clienteId: c.id, productId, nota },
    update: { nota },
  })
  revalidarEsperas()
  return ok()
}

// La espera existe para avisarle: sin un teléfono completo no hay a quién escribirle. El escrito
// reemplaza al guardado; vacío solo vale si el cliente ya tiene uno. Se valida ANTES de crear al
// cliente, para no dejar uno nuevo sin teléfono cuando la espera se rechaza.
async function clienteDeEspera(formData: FormData): Promise<{ id: number } | string> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return 'Escribí el nombre del cliente.'
  const telefono = (formData.get('telefono') as string)?.trim() || null
  if (telefono && !telefonoIntl(telefono)) return 'El teléfono no está completo: escribilo con el código, ej. 0414-1234567.'
  if (!telefono) {
    const existente = await findClienteByNombre(nombre)
    if (!telefonoIntl(existente?.telefono)) return `Escribí el teléfono de ${existente?.nombre ?? nombre}: sin él no se le puede avisar.`
    return existente!
  }
  const { cliente, created } = await findOrCreateCliente(nombre, telefono)
  if (!created) await db.cliente.update({ where: { id: cliente.id }, data: { telefono } })
  return cliente
}

// Desde /esperas/new: un cliente y las piezas que espera, elegidas en el buscador del catálogo.
export async function agregarEsperas(formData: FormData): Promise<ActionResult> {
  let ids: unknown
  try { ids = JSON.parse(String(formData.get('productIds') ?? '[]')) } catch { ids = null }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger)) return fallo('Agregá al menos una pieza.')
  const unicos = [...new Set(ids as number[])]
  if (await db.product.count({ where: { id: { in: unicos } } }) !== unicos.length) return fallo('Alguna pieza ya no está en el catálogo. Recargá la página.')
  const nota = (formData.get('nota') as string)?.trim() || null

  const cliente = await clienteDeEspera(formData)
  if (typeof cliente === 'string') return fallo(cliente)
  await db.$transaction(unicos.map(productId => db.espera.upsert({
    where: { clienteId_productId: { clienteId: cliente.id, productId } },
    create: { clienteId: cliente.id, productId, nota },
    update: { nota },
  })))
  revalidarEsperas()
  redirect('/esperas')
}

// Ya se le avisó o ya no la quiere: sale de la lista. deleteMany para que un doble clic no falle.
export async function quitarEspera(id: number): Promise<ActionResult> {
  await db.espera.deleteMany({ where: { id } })
  revalidarEsperas()
  return ok()
}
