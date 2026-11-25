import Link from 'next/link'
import { db } from '@/lib/db'
import DeleteButton from '@/components/DeleteButton'
import { avisoEspera } from '@/components/ListaEspera'
import { quitarEspera } from '../clientes/actions'
import { enlaceWhatsApp, telefonoIntl } from '@/lib/utils'

export const metadata = { title: 'Lista de espera' }

// Clientes que preguntaron por una pieza sin pedirla. Lo que ya llegó va arriba (el que preguntó
// primero antes): es a quien hay que avisar. Se anota en /esperas/new, sin buscar la pieza antes.

const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Caracas' })

export default async function EsperasPage({ searchParams }: { searchParams: Promise<{ q?: string; llego?: string }> }) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ''
  const soloLlego = sp.llego === '1'
  const esperas = await db.espera.findMany({
    select: {
      id: true, nota: true, createdAt: true,
      cliente: { select: { id: true, nombre: true, telefono: true } },
      product: { select: { id: true, nameEs: true, bajajCode: true, altSku: true, stock: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const filas = esperas
    .map(e => ({ ...e, llego: e.product.stock > 0, pieza: e.product.bajajCode ? `${e.product.nameEs} (${e.product.bajajCode})` : e.product.nameEs }))
    // Lo que llegó primero; dentro de cada grupo, el que preguntó antes.
    .sort((a, b) => Number(b.llego) - Number(a.llego))
  const porAvisar = filas.filter(f => f.llego)
  const t = q.toLowerCase()
  const visibles = filas.filter(f =>
    (!soloLlego || f.llego) &&
    (!t || [f.cliente.nombre, f.product.nameEs, f.product.bajajCode ?? '', f.product.altSku ?? '', f.nota ?? ''].some(s => s.toLowerCase().includes(t))))
  const filtrado = q !== '' || soloLlego

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Lista de espera</h1>
        <Link
          href="/esperas/new"
          className="inline-flex items-center min-h-10 bg-blue-600 text-white px-4 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
        >
          + Anotar espera
        </Link>
      </div>

      {filas.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-500">
          <p className="text-lg">Nadie está esperando</p>
          <p className="text-sm mt-2">
            <Link href="/esperas/new" className="text-blue-600 hover:underline">Anotar una espera</Link>
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <Link
              href={porAvisar.length > 0 ? '/esperas?llego=1' : '/esperas'}
              className={`col-span-2 lg:col-span-1 block rounded-xl border p-4 sm:p-5 transition-colors ${
                porAvisar.length > 0 ? 'bg-green-50 border-green-300 hover:bg-green-100' : 'bg-white border-gray-200 hover:bg-gray-50'
              }`}
            >
              <p className={`text-xs ${porAvisar.length > 0 ? 'text-green-900' : 'text-gray-500'}`}>Ya llegó · por avisar</p>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${porAvisar.length > 0 ? 'text-green-900' : 'text-gray-900'}`}>{porAvisar.length}</p>
              <p className={`text-xs mt-1 ${porAvisar.length > 0 ? 'text-green-900 font-medium' : 'text-gray-500'}`}>
                {porAvisar.length === 0 ? 'Nada de lo que esperan está aquí todavía' : <span className="underline underline-offset-2">Ver a quién →</span>}
              </p>
            </Link>
            <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
              <p className="text-xs text-gray-500">Esperando</p>
              <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums">{filas.length - porAvisar.length}</p>
              <p className="text-xs text-gray-500 mt-1">
                {new Set(filas.map(f => f.cliente.id)).size} {new Set(filas.map(f => f.cliente.id)).size === 1 ? 'cliente' : 'clientes'} en total
              </p>
            </div>
          </div>

          <form role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 grow sm:grow-0">
              Buscar
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Cliente, pieza o código…"
                className="h-10 w-full sm:w-60 border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>
            <label className="inline-flex items-center gap-2 h-10 text-sm text-gray-700">
              <input type="checkbox" name="llego" value="1" defaultChecked={soloLlego} className="size-4 rounded border-gray-300 text-blue-600" />
              Solo lo que ya llegó
            </label>
            <button type="submit" className="h-10 px-4 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50">
              Filtrar
            </button>
            {filtrado && (
              <Link href="/esperas" className="inline-flex items-center h-10 px-2 text-sm text-gray-600 hover:text-gray-900 hover:underline">
                Limpiar
              </Link>
            )}
          </form>

          {visibles.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-10 text-center">
              <p className="text-sm text-gray-600 break-words">Nada con ese filtro.</p>
              <p className="text-sm mt-2"><Link href="/esperas" className="text-blue-600 hover:underline">Limpiar filtros</Link></p>
            </div>
          ) : (
            <section aria-labelledby="esperas-lista">
              <h2 id="esperas-lista" className="text-sm font-semibold text-gray-700 mb-2">
                {visibles.length} {visibles.length === 1 ? 'espera' : 'esperas'}
              </h2>

              {/* Escritorio: tabla. */}
              <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500 whitespace-nowrap">
                    <tr>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Desde</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Cliente</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Pieza</th>
                      <th scope="col" className="text-left font-medium px-4 py-2.5">Estado</th>
                      <th scope="col" className="px-4 py-2.5"><span className="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibles.map(f => (
                      <tr key={f.id} className="align-top hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-gray-600 tabular-nums">{fecha(f.createdAt)}</td>
                        <td className="px-4 py-3 min-w-40">
                          <Link href={`/clientes/${f.cliente.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline break-words">
                            {f.cliente.nombre}
                          </Link>
                        </td>
                        <td className="px-4 py-3 min-w-56">
                          <Link href={`/products/${f.product.id}`} className="text-gray-900 hover:text-blue-700 hover:underline break-words">
                            {f.product.nameEs}
                          </Link>
                          {f.product.bajajCode && <span className="ml-1.5 font-mono text-xs text-gray-500">{f.product.bajajCode}</span>}
                          {f.nota && <p className="text-xs text-gray-500 mt-0.5 max-w-md line-clamp-2 break-words text-pretty" title={f.nota}>{f.nota}</p>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap"><Estado stock={f.product.stock} /></td>
                        <td className="px-4 py-3"><Acciones f={f} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Teléfono: tarjetas. */}
              <ul className="md:hidden space-y-2.5">
                {visibles.map(f => (
                  <li key={f.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 tabular-nums">{fecha(f.createdAt)}</span>
                      <Estado stock={f.product.stock} />
                    </div>
                    <Link href={`/clientes/${f.cliente.id}`} className="block py-1 text-base font-semibold text-gray-900 break-words">
                      {f.cliente.nombre}
                    </Link>
                    <Link href={`/products/${f.product.id}`} className="block text-sm text-gray-700 break-words">
                      {f.product.nameEs}
                      {f.product.bajajCode && <span className="ml-1.5 font-mono text-xs text-gray-500">{f.product.bajajCode}</span>}
                    </Link>
                    {f.nota && <p className="text-sm text-gray-500 break-words text-pretty">{f.nota}</p>}
                    <div className="border-t border-gray-100 pt-2"><Acciones f={f} /></div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Estado({ stock }: { stock: number }) {
  return stock > 0
    ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">Llegó · hay {stock}</span>
    : <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">Esperando</span>
}

function Acciones({ f }: { f: { id: number; pieza: string; llego: boolean; cliente: { nombre: string; telefono: string | null } } }) {
  const tel = telefonoIntl(f.cliente.telefono)
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      {/* Sin teléfono, wa.me deja elegir el contacto en WhatsApp. */}
      <a
        href={enlaceWhatsApp(tel, avisoEspera(f.cliente.nombre, f.pieza))}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center min-h-8 px-3 rounded-lg text-xs font-medium ${
          f.llego ? 'bg-green-600 text-white hover:bg-green-700' : 'border border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
        }`}
      >
        Avisar<span className="sr-only"> a {f.cliente.nombre} por WhatsApp (abre en otra pestaña)</span>
      </a>
      <DeleteButton
        action={quitarEspera.bind(null, f.id)}
        confirmMessage={`¿Quitar a ${f.cliente.nombre} de la espera de «${f.pieza}»?`}
        label="Quitar"
        pendingLabel="Quitando..."
        ariaLabel={`Quitar a ${f.cliente.nombre} de la espera de ${f.pieza}`}
      />
    </div>
  )
}
