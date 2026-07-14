import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import ProductForm from '@/components/ProductForm'
import type { ConfigMap } from '@/lib/calc'
import { updateProduct } from '../../actions'

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [product, groups, configRows] = await Promise.all([
    db.product.findUnique({ where: { id } }),
    db.product.findMany({
      where: { isAssembly: true, id: { not: id } },
      orderBy: { nameEs: 'asc' },
      select: { id: true, nameEs: true, bajajCode: true },
    }),
    db.config.findMany(),
  ])
  if (!product) notFound()

  const cfg = configRows.reduce<ConfigMap>((acc, r) => { acc[r.key] = r.value; return acc }, {})

  const updateAction = updateProduct.bind(null, id)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/products" className="text-gray-400 hover:text-gray-600 text-sm">Productos</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Editar Producto</h1>
      </div>
      <ProductForm
        action={updateAction}
        groups={groups}
        cfg={cfg}
        submitLabel="Guardar Cambios"
        defaultValues={{
          bajajCode:        product.bajajCode,
          sourceUrl:        product.sourceUrl,
          nameEs:           product.nameEs,
          nameEn:           product.nameEn,
          description:      product.description,
          notes:            product.notes,
          compatibleModels: product.compatibleModels,
          weightGrams:      product.weightGrams,
          dimL:             product.dimL,
          dimA:             product.dimA,
          dimH:             product.dimH,
          priceInr:         product.priceInr,
          landedCostUsd:    product.landedCostUsd ? parseFloat(product.landedCostUsd.toString()) : null,
          isAssembly:       product.isAssembly,
          margin:           product.margin,
          price:            parseFloat(product.price.toString()),
          priceLocked:      product.priceLocked,
          stock:            product.stock,
        }}
      />
    </div>
  )
}
