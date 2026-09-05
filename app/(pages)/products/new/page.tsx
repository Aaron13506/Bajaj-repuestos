import { db } from '@/lib/db'
import Link from 'next/link'
import ProductForm from '@/components/ProductForm'
import type { ConfigMap } from '@/lib/calc'
import { createProduct } from '../actions'
import { toConfigMap, margenPorDefecto } from '@/lib/config'

export default async function NewProductPage() {
  const [groups, configRows] = await Promise.all([
    db.product.findMany({
      where: { isAssembly: true },
      orderBy: { nameEs: 'asc' },
      select: { id: true, nameEs: true, bajajCode: true },
    }),
    db.config.findMany(),
  ])

  const cfg = toConfigMap(configRows)
  const defaultMargin = margenPorDefecto(cfg)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/products" className="text-gray-400 hover:text-gray-600 text-sm">Productos</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Nuevo Producto</h1>
      </div>
      <ProductForm
        action={createProduct}
        groups={groups}
        cfg={cfg}
        defaultValues={{ margin: defaultMargin }}
        submitLabel="Guardar Producto"
      />
    </div>
  )
}
