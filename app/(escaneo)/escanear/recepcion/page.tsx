import Link from 'next/link'
import { db } from '@/lib/db'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import CamposBulto from '@/components/CamposBulto'
import { llegoYContar } from './actions'

export const metadata = { title: 'Recibir' }

const nombre = (e: { id: number; nombre: string | null; supplier: { name: string } | null }) =>
  `${e.nombre ?? `Caja #${e.id}`} · ${e.supplier?.name ?? '99rpm'}`

// Modo Recibir: las cajas que se están contando y las que vienen en camino (para marcar que
// llegaron y empezar a contar sin pasar por la laptop).
export default async function RecibirPage() {
  const [abiertas, enCamino] = await Promise.all([
    db.recepcion.findMany({
      where: { cerradaAt: null },
      orderBy: { abiertaAt: 'desc' },
      select: { id: true, envio: { select: { id: true, nombre: true, supplier: { select: { name: true } } } }, lineas: { select: { contado: true } } },
    }),
    db.envio.findMany({
      where: {
        llegadaAt: null,
        recepciones: { none: {} },
        OR: [
          { modo: 'maritimo_cbm', estado: 'confirmado' },
          { estado: { not: 'borrador' }, items: { some: { isLanded: false, shippingStatus: 'camino_venezuela' } } },
        ],
      },
      orderBy: { id: 'desc' },
      select: { id: true, nombre: true, supplier: { select: { name: true } } },
    }),
  ])

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">← Modos</Link>
        <h1 className="text-lg font-bold text-gray-900">Recibir</h1>
        <span className="w-16" />
      </div>
      <section aria-labelledby="contando" className="space-y-2">
        <h2 id="contando" className="font-semibold text-gray-900">Contándose</h2>
        {abiertas.length === 0 && <p className="text-sm text-gray-600">Ninguna caja se está contando.</p>}
        {abiertas.map(r => (
          <Link key={r.id} href={`/escanear/recepcion/${r.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm active:bg-gray-100">
            <span className="block font-semibold text-gray-900">{nombre(r.envio)}</span>
            <span className="text-sm text-gray-600">{r.lineas.filter(l => l.contado != null).length} de {r.lineas.length} códigos contados</span>
          </Link>
        ))}
      </section>
      <section aria-labelledby="camino" className="space-y-2">
        <h2 id="camino" className="font-semibold text-gray-900">En camino</h2>
        {enCamino.length === 0 && <p className="text-sm text-gray-600">No hay cajas camino a Venezuela sin marcar.</p>}
        {enCamino.map(e => (
          <FormConResultado key={e.id} action={llegoYContar.bind(null, e.id)} className="space-y-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex-1 font-semibold text-gray-900">{nombre(e)}</span>
              <PendingButton pendingLabel="Abriendo…" className="min-h-11 rounded-lg bg-blue-600 px-4 font-semibold text-white disabled:opacity-50">Llegó: contar</PendingButton>
            </div>
            {/* Opcional: para comparar contra lo que cobró el transportista. */}
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-blue-700">Pesar el bulto (opcional)</summary>
              <CamposBulto grande />
            </details>
          </FormConResultado>
        ))}
      </section>
    </div>
  )
}
