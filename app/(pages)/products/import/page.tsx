import Link from 'next/link'
import ImportProductsForm from '@/components/ImportProductsForm'

export default function ImportProductsPage() {
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/products" className="text-gray-400 hover:text-gray-600 text-sm">Productos</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Importar desde JSON</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Pedile a la IA que extraiga los datos de los productos de la página y te los devuelva como JSON
        (usá el prompt de abajo). Después pegá el resultado acá para crearlos en lote.
      </p>
      <ImportProductsForm />
    </div>
  )
}
