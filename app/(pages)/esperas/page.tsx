import Link from 'next/link'
import { db } from '@/lib/db'
import DeleteButton from '@/components/DeleteButton'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import { avisoEspera } from '@/components/ListaEspera'
import { agregarEsperaLibre, quitarEspera } from '../clientes/actions'
import { telefonoIntl } from '@/lib/utils'

export const metadata = { title: 'Lista de espera' }

// Clientes que preguntaron por una pieza sin pedirla. Se anotan acá sin buscar la pieza antes; lo que
// ya llegó va arriba (para avisar, el que preguntó primero antes) y el resto en orden de llegada.

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })

const cargarEsperas = () =>
  db.espera.findMany({
    select: {
      id: true, nota: true, createdAt: true,
      cliente: { select: { id: true, nombre: true, telefono: true } },
      product: { select: { id: true, nameEs: true, bajajCode: true, stock: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
type Fila = Awaited<ReturnType<typeof cargarEsperas>>[number]

export default async function EsperasPage() {
  const [esperas, clientes, productos] = await Promise.all([
    cargarEsperas(),
    db.cliente.findMany({ select: { nombre: true }, orderBy: { nombre: 'asc' } }),
    db.product.findMany({ select: { nameEs: true, bajajCode: true }, orderBy: { nameEs: 'asc' } }),
  ])
  const llegaron = esperas.filter(e => e.product.stock > 0)
  const esperando = esperas.filter(e => e.product.stock <= 0)

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Lista de espera</h1>
        <p className="text-sm text-gray-500 mt-1">Clientes que preguntaron por una pieza sin pedirla. Cuando llega, aparece en Inicio para avisarles.</p>
      </div>

      <FormConResultado action={agregarEsperaLibre} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1">Cliente</span>
          <input name="nombre" list="esperas-clientes" required autoComplete="off" className={INPUT} />
          <datalist id="esperas-clientes">
            {clientes.map(c => <option key={c.nombre} value={c.nombre} />)}
          </datalist>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1">Pieza (código o nombre)</span>
          <input name="pieza" list="esperas-piezas" required autoComplete="off" className={INPUT} />
          <datalist id="esperas-piezas">
            {productos.map((p, i) => <option key={i} value={p.bajajCode ? `${p.bajajCode} · ${p.nameEs}` : p.nameEs} />)}
          </datalist>
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs font-medium text-gray-500 mb-1">Nota (opcional)</span>
          <input name="nota" placeholder="cuántas, para qué moto…" className={INPUT} />
        </label>
        <div className="sm:col-span-2">
          <PendingButton className="min-h-10 px-4 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
            Anotar
          </PendingButton>
        </div>
      </FormConResultado>

      <Seccion titulo={`Ya llegó: avisar (${llegaron.length})`} vacio="Nada de lo que esperan está aquí todavía." filas={llegaron} />
      <Seccion titulo={`Esperando (${esperando.length})`} vacio="Nadie está esperando una pieza." filas={esperando} />
    </div>
  )
}

function Seccion({ titulo, vacio, filas }: { titulo: string; vacio: string; filas: Fila[] }) {
  return (
    <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <h2 className="px-4 sm:px-6 py-3 border-b border-gray-100 bg-gray-50 text-sm font-semibold text-gray-500 uppercase tracking-wide">{titulo}</h2>
      {filas.length === 0 ? (
        <p className="px-4 sm:px-6 py-4 text-sm text-gray-500">{vacio}</p>
      ) : (
        <ul className="divide-y divide-gray-50">
          {filas.map(e => {
            const pieza = e.product.bajajCode ? `${e.product.nameEs} (${e.product.bajajCode})` : e.product.nameEs
            const tel = telefonoIntl(e.cliente.telefono)
            return (
              <li key={e.id} className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="min-w-0 flex-1">
                  <Link href={`/clientes/${e.cliente.id}`} className="font-medium text-gray-900 hover:text-blue-600">{e.cliente.nombre}</Link>
                  <span className="text-gray-400"> · </span>
                  <Link href={`/products/${e.product.id}`} className="text-blue-600 hover:underline break-words">{pieza}</Link>
                  {e.product.stock > 0 && <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Hay {e.product.stock}</span>}
                  <span className="block text-xs text-gray-500">
                    {fecha(e.createdAt)}{e.nota && <> · <span className="text-gray-600">{e.nota}</span></>}
                  </span>
                </span>
                {/* Sin teléfono, wa.me deja elegir el contacto en WhatsApp. */}
                <a
                  href={`https://wa.me/${tel ?? ''}?text=${encodeURIComponent(avisoEspera(e.cliente.nombre, pieza))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-700 hover:underline"
                >
                  Avisar<span className="sr-only"> a {e.cliente.nombre} por WhatsApp (abre en otra pestaña)</span>
                </a>
                <DeleteButton
                  action={quitarEspera.bind(null, e.id)}
                  confirmMessage={`¿Quitar a ${e.cliente.nombre} de la espera de «${e.product.nameEs}»?`}
                  label="Quitar"
                  pendingLabel="Quitando..."
                  ariaLabel={`Quitar a ${e.cliente.nombre} de la espera de ${e.product.nameEs}`}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
