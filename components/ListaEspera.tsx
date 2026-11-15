import Link from 'next/link'
import DeleteButton from '@/components/DeleteButton'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import { agregarEspera, quitarEspera } from '@/app/(pages)/clientes/actions'
import { telefonoIntl } from '@/lib/utils'

// Lista de espera de una pieza en su ficha: quién preguntó, en orden de llegada (al primero se le
// avisa primero), y el formulario para anotar a alguien más.

export const avisoEspera = (nombre: string, pieza: string) =>
  `Hola ${nombre}, ya tenemos disponible: ${pieza}. ¿Todavía le interesa?`

interface Props {
  productId: number
  pieza: string
  stock: number
  esperas: { id: number; nota: string | null; createdAt: Date; cliente: { id: number; nombre: string; telefono: string | null } }[]
  clientes: string[]
}

const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })

export default function ListaEspera({ productId, pieza, stock, esperas, clientes }: Props) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h2 className="font-semibold text-gray-900">Clientes esperando ({esperas.length})</h2>
      <p className="text-xs text-gray-500 mb-3">
        Preguntaron sin pedir. {stock > 0 ? `Hay ${stock} aquí: avisales en este orden.` : 'Cuando llegue, aparecen en Inicio.'}
      </p>
      {esperas.length > 0 && (
        <ol className="divide-y divide-gray-100 mb-4">
          {esperas.map((e, i) => {
            const tel = telefonoIntl(e.cliente.telefono)
            return (
              <li key={e.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-gray-500 tabular-nums">{i + 1}.</span>
                <span className="min-w-0 flex-1">
                  <Link href={`/clientes/${e.cliente.id}`} className="font-medium text-blue-600 hover:underline">{e.cliente.nombre}</Link>
                  <span className="ml-2 text-xs text-gray-500">{fecha(e.createdAt)}</span>
                  {e.nota && <span className="block text-xs text-gray-600 break-words">{e.nota}</span>}
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
                  confirmMessage={`¿Quitar a ${e.cliente.nombre} de la lista de espera?`}
                  label="Quitar"
                  pendingLabel="Quitando..."
                  ariaLabel={`Quitar a ${e.cliente.nombre} de la lista de espera`}
                />
              </li>
            )
          })}
        </ol>
      )}
      <FormConResultado action={agregarEspera.bind(null, productId)} className="flex flex-wrap items-end gap-2">
        <label className="block min-w-40 flex-1">
          <span className="block text-xs font-medium text-gray-500 mb-1">Cliente</span>
          <input
            name="nombre"
            list="clientes-espera"
            required
            autoComplete="off"
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <datalist id="clientes-espera">
            {clientes.map(n => <option key={n} value={n} />)}
          </datalist>
        </label>
        <label className="block min-w-40 flex-[2]">
          <span className="block text-xs font-medium text-gray-500 mb-1">Nota (opcional)</span>
          <input
            name="nota"
            placeholder="cuántas, para qué moto…"
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </label>
        <PendingButton className="min-h-8 px-3 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">
          Anotar
        </PendingButton>
      </FormConResultado>
    </div>
  )
}
