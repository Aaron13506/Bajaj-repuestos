import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toModelIds, fullModel } from '@/lib/modelo'
import { toJSON } from '@/lib/utils'
import { toNum, toInt } from '@/lib/parse'

function falla(donde: string, error: unknown, mensaje: string): NextResponse {
  console.error(`[api/products] ${donde}:`, error)
  return NextResponse.json({ error: mensaje }, { status: 500 })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''

    // `parseInt('abc')` da NaN, y NaN sobrevivía a Math.max/Math.min: entraba como
    // `skip: NaN` y Prisma tiraba, así que `?page=x` era un 500 servido desde la URL.
    // toInt devuelve null y el `??` pone el valor por defecto.
    const page = Math.max(1, toInt(searchParams.get('page')) ?? 1)
    const limit = Math.min(100, Math.max(1, toInt(searchParams.get('limit')) ?? 20))
    const categoryId = toInt(searchParams.get('categoryId'))

    const where = {
      AND: [
        search ? {
          OR: [
            { nameEs: { contains: search, mode: 'insensitive' as const } },
            { nameEn: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {},
        categoryId != null ? { categoryId } : {},
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
  } catch (e) {
    return falla('GET', e, 'Error al obtener productos')
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { nameEs = body.name, nameEn, bajajCode, description, price, stock, sourceUrl, models, compatibleModels, priceInr, weightGrams } = body

    // `price` se valida como número, no solo como presente: antes un `price: "abc"`
    // pasaba el chequeo, llegaba a Prisma como NaN y salía como un 500 sin explicación.
    const precio = toNum(price)
    if (!nameEs || precio == null) {
      return NextResponse.json({ error: 'Campos requeridos: nameEs, price (numérico)' }, { status: 400 })
    }

    const product = await db.product.create({
      data: {
        nameEs,
        nameEn:           nameEn || null,
        bajajCode:        bajajCode || null,
        sourceUrl:        sourceUrl || null,
        description:      description || null,
        compatibleModels: toModelIds(models ?? compatibleModels).map(fullModel).join(', ') || null,
        price:            precio,
        stock:            toInt(stock) ?? 0,
        // 0 en el costo de origen o en el peso es una lectura fallida, no un valor.
        priceInr:         toInt(priceInr) || null,
        weightGrams:      toInt(weightGrams) || null,
      },
    })

    return NextResponse.json(toJSON(product), { status: 201 })
  } catch (e) {
    return falla('POST', e, 'Error al crear producto')
  }
}
