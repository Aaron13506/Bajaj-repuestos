'use server'

import { db } from '@/lib/db'
import { redirect } from 'next/navigation'
import { findOrCreateCliente, isUniqueViolation, revalidateClientes } from '@/lib/clientes'

export async function createCliente(formData: FormData) {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return
  const telefono = (formData.get('telefono') as string)?.trim() || null

  const { cliente, created } = await findOrCreateCliente(nombre, telefono)
  revalidateClientes()
  // Si ya existía no se crea un duplicado, pero hay que decirlo: antes el form se
  // limpiaba y parecía que había agregado algo.
  if (!created) redirect(`/clientes?existe=${cliente.id}`)
}

export async function updateCliente(id: number, formData: FormData) {
  const nombre = (formData.get('nombre') as string)?.trim()
  if (!nombre) return
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
