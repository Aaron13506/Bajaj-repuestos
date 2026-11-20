import { db } from '@/lib/db'
import Link from 'next/link'
import ProductForm from '@/components/ProductForm'
import type { ConfigMap } from '@/lib/calc'
import { createProduct, createProductYVolver } from '../actions'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toConfigMap, margenPorDefecto } from '@/lib/config'

export const metadata = { title: 'Nuevo producto' }

// `?sku=` llega desde Consultar o una recepción: un código escaneado que no está en el catálogo.
// `?volver=` (desde la recepción): al guardar vuelve al conteo.
export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ sku?: string; volver?: string }> }) {
  const { sku, volver } = await searchParams
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
        action={volver ? createProductYVolver.bind(null, volver) : createProduct}
        groups={groups.map(g => ({ id: g.id, nameEs: nombreEnsamble(g), compatibleModels: g.compatibleModels }))}
        cfg={cfg}
        defaultValues={{ margin: defaultMargin, bajajCode: sku?.trim() || null, medidaBase: 'empaque' }}
        submitLabel="Guardar Producto"
      />
    </div>
  )
}
