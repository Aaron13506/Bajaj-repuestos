import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toModelIds, fullModel } from '@/lib/modelo'
import { toJSON } from '@/lib/utils'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''
    const categoryId = searchParams.get('categoryId')
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'))
    const limit = Math.min(100, parseInt(searchParams.get('limit') ?? '20'))

    const where = {
      AND: [
        search ? {
          OR: [
            { nameEs: { contains: search, mode: 'insensitive' as const } },
            { nameEn: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {},
        categoryId ? { categoryId: parseInt(categoryId) } : {},
      ],
    }

    const [products, total] = await Promise.all([
      db.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      db.product.count({ where }),
    ])

    return NextResponse.json({
      data: toJSON(products),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch {
    return NextResponse.json({ error: 'Error al obtener productos' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { nameEs = body.name, nameEn, bajajCode, description, price, stock, sourceUrl, models, compatibleModels, priceInr, weightGrams } = body

    if (!nameEs || price === undefined) {
      return NextResponse.json({ error: 'Campos requeridos: nameEs, price' }, { status: 400 })
    }

    const product = await db.product.create({
      data: {
        nameEs,
        nameEn:           nameEn || null,
        bajajCode:        bajajCode || null,
        sourceUrl:        sourceUrl || null,
        description:      description || null,
        compatibleModels: toModelIds(models ?? compatibleModels).map(fullModel).join(', ') || null,
        price:            parseFloat(price),
        stock:            parseInt(stock ?? '0'),
        priceInr:         priceInr ? parseInt(priceInr) : null,
        weightGrams:      weightGrams ? parseInt(weightGrams) : null,
      },
    })

    return NextResponse.json(toJSON(product), { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Error al crear producto' }, { status: 500 })
  }
}
