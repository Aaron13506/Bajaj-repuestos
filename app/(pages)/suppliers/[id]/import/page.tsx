import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import ImportSupplierPricesForm from '@/components/ImportSupplierPricesForm'

export default async function ImportSupplierPricesPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const supplier = await db.supplier.findUnique({ where: { id } })
  if (!supplier) notFound()

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/suppliers" className="text-gray-400 hover:text-gray-600 text-sm">Proveedores</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Importar precios — {supplier.name}</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Pegá una lista de precios en USD por SKU para <strong>{supplier.name}</strong>. Los SKU que
        coincidan con el código Bajaj de un producto actualizan (o crean) su precio para este
        proveedor; el resto del catálogo sigue usando el precio base de 99rpm.
      </p>
      <ImportSupplierPricesForm supplierId={id} />
    </div>
  )
}
