import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import ProductForm from '@/components/ProductForm'
import type { ConfigMap } from '@/lib/calc'
import { updateProduct } from '../../actions'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toConfigMap } from '@/lib/config'

export const metadata = { title: 'Editar producto' }

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [product, groups, configRows] = await Promise.all([
    db.product.findUnique({ where: { id } }),
    db.ensamble.findMany({
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
      select: { id: true, nameEs: true, nameEn: true, compatibleModels: true },
    }),
    db.config.findMany(),
  ])
  if (!product) notFound()

  const cfg = toConfigMap(configRows)

  const updateAction = updateProduct.bind(null, id)

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <nav aria-label="Ruta" className="flex flex-wrap items-center gap-2 text-sm mb-1">
          <Link href="/products" className="text-gray-500 hover:text-gray-600">Productos</Link>
          <span aria-hidden="true" className="text-gray-300">/</span>
          <Link href={`/products/${id}`} className="text-gray-500 hover:text-gray-600 truncate">{product.nameEs}</Link>
        </nav>
        <h1 className="text-2xl font-bold text-gray-900">Editar producto</h1>
      </div>
      <ProductForm
        action={updateAction}
        groups={groups.map(g => ({ id: g.id, nameEs: nombreEnsamble(g), compatibleModels: g.compatibleModels }))}
        cfg={cfg}
        submitLabel="Guardar cambios"
        defaultValues={{
          bajajCode:        product.bajajCode,
          altSku:           product.altSku,
          sourceUrl:        product.sourceUrl,
          imageUrl:         product.imageUrl,
          nameEs:           product.nameEs,
          nameEn:           product.nameEn,
          description:      product.description,
          notes:            product.notes,
          models: toModelIds(product.compatibleModels),
          weightGrams:      product.weightGrams,
          dimL:             product.dimL,
          dimA:             product.dimA,
          dimH:             product.dimH,
          priceInr:         product.priceInr,
          landedCostUsd:    product.landedCostUsd ? parseFloat(product.landedCostUsd.toString()) : null,
          margin:           product.margin,
          price:            parseFloat(product.price.toString()),
          priceLocked:      product.priceLocked,
          stock:            product.stock,
          medidoAt:         product.medidoAt?.toISOString() ?? null,
        }}
      />
    </div>
  )
}
