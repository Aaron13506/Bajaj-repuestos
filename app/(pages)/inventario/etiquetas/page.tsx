import Link from 'next/link'
import { db } from '@/lib/db'
import EtiquetasEstante from './EtiquetasEstante'

export const metadata = { title: 'Etiquetas de estante' }

// Etiquetas para pegar en cada estante o caja del depósito (QR "UBI:A-3"). Arranca con los estantes
// que ya tienen piezas asignadas; se agregan o quitan a mano.
export default async function EtiquetasPage() {
  const usadas = await db.product.findMany({ where: { ubicacion: { not: null } }, distinct: ['ubicacion'], select: { ubicacion: true }, orderBy: { ubicacion: 'asc' } })
  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <Link href="/inventario/conteo" className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline">← Conteo cíclico</Link>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Etiquetas de estante</h1>
        <p className="text-sm text-gray-500 mt-1 text-pretty">
          Cada etiqueta lleva un QR con <span className="font-mono">UBI:</span> y el estante: el teléfono la distingue de una pieza.
          Escaneá una pieza y después el estante para ubicarla (al recibir o en Consultar).
        </p>
      </div>
      <EtiquetasEstante inicial={usadas.map(u => u.ubicacion!)} />
    </div>
  )
}
