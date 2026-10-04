'use server'

import { db } from '@/lib/db'
import { redirect } from 'next/navigation'
import { findOrCreateCliente, isUniqueViolation, revalidateClientes } from '@/lib/clientes'
import { fallo, ok, type ActionResult } from '@/lib/action-result'

export async function createCliente(formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return fallo('Escribí el nombre del cliente.')
  const telefono = (formData.get('telefono') as string)?.trim() || null

  const { cliente, created } = await findOrCreateCliente(nombre, telefono)
  revalidateClientes()
  // Si ya existía no se crea un duplicado, pero hay que decirlo: antes el form se
  // limpiaba y parecía que había agregado algo.
  if (!created) redirect(`/clientes?existe=${cliente.id}`)
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
