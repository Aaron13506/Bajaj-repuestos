import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import EnsambleForm from '@/components/EnsambleForm'
import { actualizarEnsamble } from '../../actions'
import { nombreEnsamble } from '@/lib/linea-pedido'

export default async function EditarEnsamblePage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const ensamble = await db.ensamble.findUnique({ where: { id } })
  if (!ensamble) notFound()

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/groups" className="text-gray-400 hover:text-gray-600 text-sm">Ensambles</Link>
        <span className="text-gray-300">/</span>
        <Link href={`/ensambles/${id}`} className="text-gray-400 hover:text-gray-600 text-sm">{nombreEnsamble(ensamble)}</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Editar</h1>
      </div>
      <EnsambleForm
        action={actualizarEnsamble.bind(null, id)}
        submitLabel="Guardar cambios"
        cancelHref={`/ensambles/${id}`}
        defaultValues={{
          nameEs: ensamble.nameEs,
          nameEn: ensamble.nameEn,
          sourceUrl: ensamble.sourceUrl,
          models: toModelIds(ensamble.compatibleModels),
        }}
      />
    </div>
  )
}
