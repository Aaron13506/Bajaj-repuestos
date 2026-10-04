import Link from 'next/link'
import EnsambleForm from '@/components/EnsambleForm'
import { crearEnsamble } from '../actions'

export default function NuevoEnsamblePage() {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/groups" className="text-gray-400 hover:text-gray-600 text-sm">Ensambles</Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Nuevo ensamble</h1>
      </div>
      <EnsambleForm action={crearEnsamble} submitLabel="Guardar ensamble" cancelHref="/groups" />
    </div>
  )
}
