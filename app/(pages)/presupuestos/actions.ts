'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'
import { findOrCreateCliente, revalidateClientes } from '@/lib/clientes'

interface ItemInput {
  productId: number
  quantity: number
  salePrice: number
  bundleItems?: BundlePiece[] | null
}

// Resuelve el Cliente elegido en el builder: existente (clienteId) o uno nuevo
// creado al vuelo (nuevoClienteNombre). Solo aplica a tipo 'cliente' — el stock
// propio (tipo 'propio') no lleva Cliente, sigue con clientName de texto libre.
async function resolveCliente(formData: FormData) {
  const clienteIdRaw = (formData.get('clienteId') as string) ?? ''
  if (clienteIdRaw === '__new__') {
    const nombre = (formData.get('nuevoClienteNombre') as string)?.trim()
    if (!nombre) return null
    const telefono = (formData.get('nuevoClienteTelefono') as string)?.trim() || null
    const { cliente } = await findOrCreateCliente(nombre, telefono)
    return cliente
  }
  const id = parseInt(clienteIdRaw)
  if (isNaN(id)) return null
  return db.cliente.findUnique({ where: { id } })
}

export async function createPresupuesto(formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const tipo = (formData.get('tipo') as string) === 'propio' ? 'propio' : 'cliente'
  const items: ItemInput[] = JSON.parse(formData.get('items') as string)

  if (items.length === 0) return

  let clientName: string
  let clienteId: number | null = null
  if (tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) return
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) return
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  // El stock propio es una compra definida para revender: entra directo como
  // pedido (no necesita aprobación ni adelanto). El de cliente arranca como presupuesto.
  const status = tipo === 'propio' ? 'pedido' : 'presupuesto'

  const pedido = await db.pedido.create({
    data: {
      clientName,
      clienteId,
      notas,
      tipo,
      status,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          bundleItems: i.bundleItems && i.bundleItems.length > 0 ? (i.bundleItems as unknown as Prisma.InputJsonValue) : undefined,
        })),
      },
    },
  })

  revalidatePath('/presupuestos')
  revalidateClientes()
  // Si el lote se armó desde el planificador de embarques, se vuelve ahí: lo que sigue es
  // ver cuánto suma al m³ acumulado, no la ficha del documento suelto.
  if ((formData.get('volver') as string) === 'plan') {
    revalidatePath('/envios/plan')
    redirect('/envios/plan')
  }
  redirect(`/presupuestos/${pedido.id}`)
}

export async function updatePresupuesto(id: number, formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const existing = await db.pedido.findUnique({ where: { id }, select: { tipo: true } })
  if (!existing) return
  const items: ItemInput[] = JSON.parse(formData.get('items') as string)

  if (items.length === 0) return

  let clientName: string
  let clienteId: number | null = null
  if (existing.tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) return
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) return
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  await db.pedidoItem.deleteMany({ where: { pedidoId: id } })
  await db.pedido.update({
    where: { id },
    data: {
      clientName,
      clienteId,
      notas,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          bundleItems: i.bundleItems && i.bundleItems.length > 0 ? (i.bundleItems as unknown as Prisma.InputJsonValue) : undefined,
        })),
      },
    },
  })

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidateClientes()
  redirect(`/presupuestos/${id}`)
}

// Aprueba un presupuesto (status -> 'pedido') registrando el adelanto: monto,
// método de pago y fecha. Reutilizable para editar el adelanto de un pedido ya
// confirmado (el status ya es 'pedido' y solo se actualizan los campos del adelanto).
export async function aprobarPedido(id: number, formData: FormData) {
  const rawDeposit = (formData.get('depositUsd') as string)?.trim()
  const depositUsd = rawDeposit ? parseFloat(rawDeposit) : null
  const paymentMethod = (formData.get('paymentMethod') as string)?.trim() || null
  const rawDate = (formData.get('depositAt') as string)?.trim()
  // El input date da 'YYYY-MM-DD'; se ancla a mediodía para evitar corrimientos de zona horaria.
  const depositAt = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  await db.pedido.update({
    where: { id },
    data: {
      status: 'pedido',
      depositUsd: depositUsd != null && !Number.isNaN(depositUsd) ? depositUsd : null,
      paymentMethod,
      depositAt,
    },
  })
  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  // El adelanto y el pase a 'pedido' mueven los totales del cliente.
  revalidateClientes()
}

export async function deletePresupuesto(id: number) {
  await db.pedido.delete({ where: { id } })
  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect('/presupuestos')
}
