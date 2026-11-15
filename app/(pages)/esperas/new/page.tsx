import Link from 'next/link'
import { db } from '@/lib/db'
import EsperaForm from '@/components/EsperaForm'
import { agregarEsperas } from '../../clientes/actions'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toModelIds } from '@/lib/modelo'

export const metadata = { title: 'Anotar espera' }

export default async function NuevaEsperaPage() {
  const [clientes, ensambles] = await Promise.all([
    db.cliente.findMany({ select: { nombre: true }, orderBy: { nombre: 'asc' } }),
    db.ensamble.findMany({
      select: { id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true },
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
    }),
  ])

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <Link href="/esperas" className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline">← Lista de espera</Link>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Anotar espera</h1>
        <p className="text-sm text-gray-500 mt-1 text-pretty">
          Un cliente preguntó por una pieza y no la pidió. Cuando llegue, aparece en Inicio para avisarle.
        </p>
      </div>
      <EsperaForm
        action={agregarEsperas}
        clientes={clientes.map(c => c.nombre)}
        ensambles={ensambles.map(a => ({ id: a.id, nameEs: nombreEnsamble(a), imageUrl: a.imageUrl, models: toModelIds(a.compatibleModels) }))}
      />
    </div>
  )
}
