import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import DeleteButton from '@/components/DeleteButton'
import PagarFleteForm from '@/components/PagarFleteForm'
import SeccionCaja from '@/components/SeccionCaja'
import { estadoFlete, type TramoFlete } from '@/lib/flete-real'
import type { ActionResult } from '@/lib/action-result'

export interface PagoFlete {
  id: number
  fecha: string
  monto: number
  metodoPago: string | null
}

export interface FilaFlete {
  tramo: TramoFlete
  titulo: string
  icono: string
  facturadoUsd: number | null
  // Lo que calcula la tabla, para la diferencia. Es el estimado, nunca el facturado.
  calculadoUsd: number
  nota?: string
  pagos: PagoFlete[]
  guardar: (formData: FormData) => Promise<ActionResult>
  pagar: (formData: FormData) => Promise<ActionResult>
  deshacer: (movimientoId: number) => Promise<ActionResult>
}

const usd = (n: number) => `$${n.toFixed(2)}`
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })

const TONO: Record<string, string> = {
  sin_cargar: 'bg-gray-100 text-gray-600',
  por_pagar: 'bg-amber-100 text-amber-800',
  parcial: 'bg-amber-100 text-amber-800',
  pagado: 'bg-green-100 text-green-700',
  de_mas: 'bg-red-100 text-red-700',
}

// Lo que cobraron los transportistas. El facturado ES el costo (pisa al estimado en el landed);
// el calculado queda al lado solo como referencia. Pagar crea el egreso en el libro.
export default function FleteRealCard({ filas, methods }: { filas: FilaFlete[]; methods: readonly string[] }) {
  if (filas.length === 0) return null
  return (
    <SeccionCaja
      id="fletes-titulo"
      titulo="Pagos de flete"
      sub="Lo que facturó cada uno y lo que ya salió de tu cuenta. El facturado reemplaza al estimado en el landed; pagarlo lo anota como egreso en contabilidad."
    >
      <div className="divide-y divide-gray-100 px-4 sm:px-6">
        {filas.map(f => {
          const pagado = f.pagos.reduce((s, p) => s + p.monto, 0)
          const estado = estadoFlete(f.facturadoUsd, pagado)
          const dif = f.facturadoUsd != null && f.calculadoUsd > 0
            ? (f.facturadoUsd / f.calculadoUsd - 1) * 100
            : null
          const falta = f.facturadoUsd != null ? f.facturadoUsd - pagado : null
          return (
            <div key={f.tramo} className="py-4">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <h3 className="w-44 text-sm font-semibold text-gray-900">
                  <span aria-hidden="true">{f.icono} </span>{f.titulo}
                </h3>

                <FormConResultado action={f.guardar} className="flex items-end gap-2">
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 mb-1">Facturado (USD)</span>
                    <input
                      // Se vuelve a armar cuando cambia lo guardado, para que el campo muestre siempre el dato real.
                      key={`${f.tramo}-${f.facturadoUsd ?? ''}`}
                      type="number" step="0.01" min="0" name="facturado"
                      defaultValue={f.facturadoUsd ?? ''}
                      placeholder="sin cargar"
                      className="w-32 min-h-9 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </label>
                  <PendingButton className="min-h-9 px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
                    Guardar
                  </PendingButton>
                </FormConResultado>

                <div className="text-sm">
                  <p className="text-gray-700 mb-1">Calculado</p>
                  <p className="font-mono text-gray-700">
                    {usd(f.calculadoUsd)}
                    {dif != null && (
                      <span className={`ml-2 font-semibold ${Math.abs(dif) <= 5 ? 'text-green-700' : 'text-amber-800'}`}>
                        {dif >= 0 ? '+' : ''}{dif.toFixed(1)}%
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${TONO[estado.clave]}`}>
                    {estado.texto}
                  </span>
                  {(falta == null || falta > 0.01) && (
                    <PagarFleteForm
                      action={f.pagar}
                      methods={methods}
                      titulo={f.titulo}
                      montoSugerido={falta}
                    />
                  )}
                </div>
              </div>

              {f.nota && <p className="text-sm text-gray-600 mt-2">{f.nota}</p>}

              {f.pagos.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {f.pagos.map(p => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700">
                      <span className="font-mono">{fecha(p.fecha)}</span>
                      <span className="font-mono font-semibold">{usd(p.monto)}</span>
                      {p.metodoPago && <span className="text-gray-600">{p.metodoPago}</span>}
                      <DeleteButton
                        action={f.deshacer.bind(null, p.id)}
                        label="deshacer"
                        pendingLabel="Deshaciendo…"
                        confirmMessage={`¿Deshacer el pago de ${usd(p.monto)}? Se borra del libro de contabilidad.`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </SeccionCaja>
  )
}
