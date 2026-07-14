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
  const items: ItemInput[] = JSON.parse(formData.get('items') as string)

  if (!clientName || items.length === 0) return

  const pedido = await db.pedido.create({
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

export async function confirmarPedido(id: number) {
  await db.pedido.update({ where: { id }, data: { status: 'pedido' } })
  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
}

export async function deletePresupuesto(id: number) {
  await db.pedido.delete({ where: { id } })
  revalidatePath('/presupuestos')
  redirect('/presupuestos')
}
