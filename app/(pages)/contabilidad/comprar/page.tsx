import Link from 'next/link'
import { itemsSinCostoReal } from '@/lib/movimientos'
import { registrarCompra } from '../actions'
import { METODOS_PAGO_EGRESO } from '@/lib/pagos'
import RegistrarCompraPicker from '@/components/RegistrarCompraPicker'

export default async function ComprarPage() {
  const items = await itemsSinCostoReal()

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Link href="/contabilidad" className="text-gray-400 hover:text-gray-600 text-sm">
          Contabilidad
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Registrar compra</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6 max-w-2xl">
        Elegí las piezas que pagaste — una sola, todo un pedido, o varias sueltas de
        pedidos distintos — y poné el TOTAL que pagaste por todas juntas. El estimado de
        cada fila es solo para repartir ese total entre las piezas (nunca es exacto por la
        tasa del día); lo real es el número que pongas abajo.
      </p>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Nada pendiente de costear</p>
          <p className="text-sm mt-1">Todos los ítems de pedidos confirmados ya tienen un costo real cargado.</p>
        </div>
      ) : (
        <RegistrarCompraPicker items={items} action={registrarCompra} methods={METODOS_PAGO_EGRESO} />
      )}
    </div>
  )
}
