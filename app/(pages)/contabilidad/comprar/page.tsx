import Link from 'next/link'
import { itemsSinCostoReal } from '@/lib/movimientos'
import { registrarCompra } from '../actions'
import { METODOS_PAGO_EGRESO } from '@/lib/pagos'
import RegistrarCompraPicker from '@/components/RegistrarCompraPicker'

export const metadata = { title: 'Registrar compras' }

export default async function ComprarPage() {
  const items = await itemsSinCostoReal()

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <nav aria-label="Ruta" className="text-sm">
          <Link href="/contabilidad" className="inline-flex items-center min-h-8 text-gray-600 hover:text-gray-900 hover:underline">
            Contabilidad
          </Link>
        </nav>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Registrar compra</h1>
        <p className="text-sm text-gray-600 mt-1 max-w-2xl text-pretty">
          Tildá lo que pagaste (una pieza, un pedido entero o sueltas de varios) y escribí el total que pagaste por
          todo junto. El estimado de cada fila solo sirve para repartir ese total; lo que queda en el libro es tu número.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center">
          <p className="text-base font-semibold text-gray-900">Nada pendiente de costear</p>
          <p className="text-sm text-gray-600 mt-1">Todas las piezas de pedidos confirmados ya tienen su costo real.</p>
          <p className="text-sm mt-3">
            <Link href="/contabilidad" className="text-blue-700 hover:underline">Volver a Contabilidad</Link>
          </p>
        </div>
      ) : (
        <RegistrarCompraPicker items={items} action={registrarCompra} methods={METODOS_PAGO_EGRESO} />
      )}
    </div>
  )
}
