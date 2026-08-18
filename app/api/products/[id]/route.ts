import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import { toJSON } from '@/lib/utils'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

  const product = await db.product.findUnique({
    where: { id },
    include: {
      components: { include: { child: true }, orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }] },
      assemblies: { include: { parent: true } },
    },
  })

  if (!product) return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })

  return NextResponse.json(toJSON(product))
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseInt((await params).id)
    if (isNaN(id)) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

    const body = await request.json()
    const { nameEs, nameEn, bajajCode, description, price, stock, categoryId, sourceUrl, models, compatibleModels,
            priceInr, landedCostUsd, margin, notes, weightGrams, dimL, dimA, dimH } = body

    const product = await db.product.update({
      where: { id },
      data: {
        ...(nameEs !== undefined           && { nameEs }),
        ...(nameEn !== undefined           && { nameEn: nameEn || null }),
        ...(bajajCode !== undefined        && { bajajCode: bajajCode || null }),
        ...(sourceUrl !== undefined        && { sourceUrl: sourceUrl || null }),
        ...(description !== undefined      && { description: description || null }),
        ...(notes !== undefined            && { notes: notes || null }),
        ...((models ?? compatibleModels) !== undefined && { models: toModelIds(models ?? compatibleModels) }),
        ...(price !== undefined            && { price: parseFloat(price) }),
        ...(stock !== undefined            && { stock: parseInt(stock) }),
        ...(priceInr !== undefined         && { priceInr: priceInr ? parseInt(priceInr) : null }),
        ...(landedCostUsd !== undefined    && { landedCostUsd: landedCostUsd ? parseFloat(landedCostUsd) : null }),
        ...(margin !== undefined           && { margin: margin ? parseFloat(margin) : null }),
        ...(weightGrams !== undefined      && { weightGrams: weightGrams ? parseInt(weightGrams) : null }),
        ...(dimL !== undefined             && { dimL: dimL ? parseFloat(dimL) : null }),
        ...(dimA !== undefined             && { dimA: dimA ? parseFloat(dimA) : null }),
        ...(dimH !== undefined             && { dimH: dimH ? parseFloat(dimH) : null }),
      },
    })

    return NextResponse.json(toJSON(product))
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })
    return NextResponse.json({ error: 'Error al actualizar producto' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseInt((await params).id)
    if (isNaN(id)) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

    await db.product.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })
    return NextResponse.json({ error: 'Error al eliminar producto' }, { status: 500 })
  }
}
