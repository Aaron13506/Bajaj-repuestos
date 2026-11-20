import Link from 'next/link'
import { notFound } from 'next/navigation'
import { vistaRecepcion } from '@/lib/recepcion-db'
import { limpiarNombre } from '@/lib/utils'
import ConteoCaja from '@/components/ConteoCaja'

export const metadata = { title: 'Recibir caja' }

// Recibir una caja desde el teléfono: el enlace del QR que muestra la laptop. Las mismas acciones
// que la laptop, así las dos pantallas pueden contar a la vez.
export default async function RecepcionTelefonoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const vista = await vistaRecepcion(Number(id))
  if (!vista) notFound()
  const caja = `${vista.envio.nombre ?? `Caja #${vista.envio.id}`} · ${vista.envio.supplier?.name ?? '99rpm'}`
  const contadas = vista.lineas.filter(l => l.contado != null).length

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear/recepcion" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">← Recibir</Link>
        <h1 className="min-w-0 truncate text-right text-base font-bold text-gray-900">{caja} · {contadas}/{vista.lineas.length}</h1>
      </div>
      {vista.cerradaAt ? (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-lg font-semibold text-gray-900">Esta recepción ya está cerrada.</p>
          <ul className="divide-y divide-gray-100 text-sm">
            {vista.lineas.map(l => {
              const dif = (l.contado ?? 0) - l.esperado
              return (
                <li key={l.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate">{limpiarNombre(l.nombre)} <span className="font-mono text-gray-600">{l.codigo ?? ''}</span></span>
                  <span className={`font-mono ${dif < 0 ? 'text-red-700' : dif > 0 ? 'text-amber-800' : 'text-gray-700'}`}>{l.contado ?? 0} de {l.esperado}</span>
                </li>
              )
            })}
          </ul>
          <Link href={`/envios/${vista.envioId}#llegada`} className="font-semibold text-blue-700 underline">Ver la caja</Link>
        </div>
      ) : (
        <ConteoCaja vista={vista} volver={`/escanear/recepcion/${vista.id}`} telefono />
      )}
    </div>
  )
}
