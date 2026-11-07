import { db } from '@/lib/db'
import Link from 'next/link'
import ProductForm from '@/components/ProductForm'
import type { ConfigMap } from '@/lib/calc'
import { createProduct } from '../actions'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toConfigMap, margenPorDefecto } from '@/lib/config'

export const metadata = { title: 'Nuevo producto' }

export default async function NewProductPage() {
  const [groups, configRows] = await Promise.all([
    db.ensamble.findMany({
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
      select: { id: true, nameEs: true, nameEn: true, compatibleModels: true },
    }),
    db.config.findMany(),
  ])

  const cfg = toConfigMap(configRows)
  const defaultMargin = margenPorDefecto(cfg)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/products" className="text-gray-500 hover:text-gray-600 text-sm">Productos</Link>
        <span aria-hidden="true" className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Nuevo producto</h1>
      </div>
      <ProductForm
        action={createProduct}
        groups={groups.map(g => ({ id: g.id, nameEs: nombreEnsamble(g), compatibleModels: g.compatibleModels }))}
        cfg={cfg}
        defaultValues={{ margin: defaultMargin }}
        submitLabel="Guardar Producto"
      />
    </div>
  )
}
