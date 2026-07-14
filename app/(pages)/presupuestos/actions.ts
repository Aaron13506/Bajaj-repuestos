'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'

interface ItemInput {
  productId: number
  quantity: number
  salePrice: number
  bundleItems?: BundlePiece[] | null
}

export async function createPresupuesto(formData: FormData) {
  const clientName = (formData.get('clientName') as string).trim()
  const notas = (formData.get('notas') as string)?.trim() || null
  const tipo = (formData.get('tipo') as string) === 'propio' ? 'propio' : 'cliente'
  const items: ItemInput[] = JSON.parse(formData.get('items') as string)

  if (!clientName || items.length === 0) return

  // El stock propio es una compra definida para revender: entra directo como
  // pedido (no necesita aprobación ni adelanto). El de cliente arranca como presupuesto.
  const status = tipo === 'propio' ? 'pedido' : 'presupuesto'

  const pedido = await db.pedido.create({
    data: {
      clientName,
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
  redirect(`/presupuestos/${pedido.id}`)
}

export async function updatePresupuesto(id: number, formData: FormData) {
  const clientName = (formData.get('clientName') as string).trim()
  const notas = (formData.get('notas') as string)?.trim() || null
  const items: ItemInput[] = JSON.parse(formData.get('items') as string)

  if (!clientName || items.length === 0) return

  await db.pedidoItem.deleteMany({ where: { pedidoId: id } })
  await db.pedido.update({
    where: { id },
    data: {
      clientName,
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
}

export async function deletePresupuesto(id: number) {
  await db.pedido.delete({ where: { id } })
  revalidatePath('/presupuestos')
  redirect('/presupuestos')
}
