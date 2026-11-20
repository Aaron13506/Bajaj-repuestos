import Link from 'next/link'
import { db } from '@/lib/db'
import ElegirEstante from './ElegirEstante'

export const metadata = { title: 'Inventario' }

// Modo Inventario: primero el estante (UBI:), después las piezas. Los conteos abiertos se retoman
// desde acá; la lista sugerida (qué contar) está en /inventario/conteo.
export default async function InventarioTelefonoPage() {
  const abiertos = await db.conteoInventario.findMany({
    where: { cerradoAt: null },
    orderBy: { abiertoAt: 'desc' },
    select: { id: true, ubicacion: true, lineas: { select: { contado: true } } },
  })
  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/escanear" className="flex min-h-11 items-center rounded-lg pr-3 text-sm font-semibold text-blue-700">← Modos</Link>
        <h1 className="text-lg font-bold text-gray-900">Inventario</h1>
        <Link href="/inventario/conteo" className="flex min-h-11 items-center rounded-lg pl-3 text-sm font-semibold text-blue-700">Qué contar</Link>
      </div>
      <ElegirEstante />
      <section aria-labelledby="abiertos" className="space-y-2">
        <h2 id="abiertos" className="font-semibold text-gray-900">Contándose</h2>
        {abiertos.length === 0 && <p className="text-sm text-gray-600">Ningún conteo abierto.</p>}
        {abiertos.map(c => (
          <Link key={c.id} href={`/escanear/inventario/${c.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm active:bg-gray-100">
            <span className="block font-semibold text-gray-900">{c.ubicacion ? `Estante ${c.ubicacion}` : `Lista #${c.id}`}</span>
            <span className="text-sm text-gray-600">{c.lineas.filter(l => l.contado != null).length} de {c.lineas.length} piezas contadas</span>
          </Link>
        ))}
      </section>
    </div>
  )
}
