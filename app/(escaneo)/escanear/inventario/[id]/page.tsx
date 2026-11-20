import Link from 'next/link'
import { notFound } from 'next/navigation'
import { vistaConteo } from '@/lib/conteo-inventario-db'
import { limpiarNombre } from '@/lib/utils'
import ConteoInventario from './ConteoInventario'

export const metadata = { title: 'Contar estante' }

// Un conteo cíclico (docs/plan-inventario/05-ubicaciones-conteo.md): el mismo en el teléfono y en la
// laptop (el enlace de /inventario/conteo). Cerrado = resumen de solo lectura.
export default async function ConteoTelefonoPage({ params }: { params: Promise<{ id: string }> }) {
  const vista = await vistaConteo(Number((await params).id))
  if (!vista) notFound()
  const titulo = vista.ubicacion ? `Estante ${vista.ubicacion}` : `Lista #${vista.id}`
  const contadas = vista.lineas.filter(l => l.contado != null).length

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear/inventario" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">← Inventario</Link>
        <h1 className="min-w-0 truncate text-right text-base font-bold text-gray-900">{titulo} · {contadas}/{vista.lineas.length}</h1>
      </div>
      {vista.cerradoAt ? (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-lg font-semibold text-gray-900">Este conteo ya está cerrado.</p>
          {vista.notas && <p className="text-sm text-gray-700">Nota: {vista.notas}</p>}
          <ul className="divide-y divide-gray-100 text-sm">
            {vista.lineas.map(l => (
              <li key={l.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">{limpiarNombre(l.nombre)} <span className="font-mono text-gray-600">{l.codigo ?? ''}</span></span>
                <span className="font-mono text-gray-700">{l.contado ?? 'sin contar'}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-600">Las diferencias quedaron como movimientos «Conteo» en el kardex de cada pieza.</p>
        </div>
      ) : (
        <ConteoInventario vista={vista} />
      )}
    </div>
  )
}
