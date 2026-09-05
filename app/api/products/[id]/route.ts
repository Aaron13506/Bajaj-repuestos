import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toModelIds, fullModel } from '@/lib/modelo'
import { toJSON } from '@/lib/utils'
import { toNum, toInt } from '@/lib/parse'

function idDeParams(raw: string): number | null {
  const id = parseInt(raw)
  return Number.isFinite(id) ? id : null
}

// Un 500 sin rastro es un bug que no se puede investigar: el `catch` vacío que había acá
// se tragó durante semanas el error de la columna `models` (ver PUT). El detalle no viaja
// al cliente —no hace falta filtrar internos de Prisma— pero queda en el log del dyno.
function falla(donde: string, error: unknown, mensaje: string): NextResponse {
  console.error(`[api/products] ${donde}:`, error)
  return NextResponse.json({ error: mensaje }, { status: 500 })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = idDeParams((await params).id)
  if (id == null) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

  try {
    const product = await db.product.findUnique({
      where: { id },
      include: {
        components: { include: { child: true }, orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }] },
        assemblies: { include: { parent: true } },
      },
    })

    if (!product) return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })

    return NextResponse.json(toJSON(product))
  } catch (e) {
    return falla('GET', e, 'Error al obtener producto')
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = idDeParams((await params).id)
  if (id == null) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

  try {
    const body = await request.json()
    const { nameEs, nameEn, bajajCode, description, price, stock, sourceUrl, models, compatibleModels,
            priceInr, landedCostUsd, margin, notes, weightGrams, dimL, dimA, dimH } = body

    // Las motos se guardan como TEXTO en `compatibleModels`, que es lo que existe en la
    // base. Esto escribía `models`, la columna del enum que se revirtió y se dropeó en
    // e2ff02d: el PUT venía fallando en runtime contra la base, y el `catch` lo devolvía
    // como un 500 genérico que no decía nada. Peor todavía, el build en Heroku no
    // levantaba: `prisma generate` corre en el postinstall, regenera el cliente sin
    // `models`, y ahí recién el typecheck de `next build` cortaba. En local seguía en
    // verde porque el cliente de node_modules era el viejo y todavía tenía el campo.
    //
    // El POST de la ruta hermana ya escribía compatibleModels; quedó a mitad de camino.
    const modelosCrudos = models ?? compatibleModels

    const product = await db.product.update({
      where: { id },
      data: {
        ...(nameEs !== undefined      && { nameEs }),
        ...(nameEn !== undefined      && { nameEn: nameEn || null }),
        ...(bajajCode !== undefined   && { bajajCode: bajajCode || null }),
        ...(sourceUrl !== undefined   && { sourceUrl: sourceUrl || null }),
        ...(description !== undefined && { description: description || null }),
        ...(notes !== undefined       && { notes: notes || null }),
        ...(modelosCrudos !== undefined && {
          compatibleModels: toModelIds(modelosCrudos).map(fullModel).join(', ') || null,
        }),
        // `toNum`/`toInt` devuelven null en vez de NaN. Con parseFloat suelto, un
        // `price: "abc"` llegaba a Prisma como NaN y salía como 500 sin explicación.
        ...(price !== undefined         && { price: toNum(price) ?? undefined }),
        ...(stock !== undefined         && { stock: toInt(stock) ?? 0 }),
        // Para el costo de origen y las medidas, 0 es una lectura fallida y no un valor:
        // se guarda null, igual que antes.
        ...(priceInr !== undefined      && { priceInr: toInt(priceInr) || null }),
        ...(landedCostUsd !== undefined && { landedCostUsd: toNum(landedCostUsd) || null }),
        ...(margin !== undefined        && { margin: toNum(margin) || null }),
        ...(weightGrams !== undefined   && { weightGrams: toInt(weightGrams) || null }),
        ...(dimL !== undefined          && { dimL: toNum(dimL) || null }),
        ...(dimA !== undefined          && { dimA: toNum(dimA) || null }),
        ...(dimH !== undefined          && { dimH: toNum(dimH) || null }),
      },
    })

    return NextResponse.json(toJSON(product))
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })
    return falla('PUT', error, 'Error al actualizar producto')
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = idDeParams((await params).id)
  if (id == null) return NextResponse.json({ error: 'ID invalido' }, { status: 400 })

  try {
    await db.product.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return NextResponse.json({ error: 'Producto no encontrado' }, { status: 404 })
    // P2003: hay PedidoItem apuntando a este producto (onDelete: Restrict). No es un
    // error del servidor, es que el producto está vendido y no se puede borrar.
    if (e.code === 'P2003') {
      return NextResponse.json(
        { error: 'El producto está en uso (pedidos o ensambles) y no se puede eliminar' },
        { status: 409 },
      )
    }
    return falla('DELETE', error, 'Error al eliminar producto')
  }
}
