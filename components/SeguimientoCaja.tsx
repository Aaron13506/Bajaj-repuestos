import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import type { ActionResult } from '@/lib/action-result'
import { TRAMOS_TRACKING, TRAMO_TRACKING_META, esTramoTracking } from '@/lib/tracking'
import { fechaCourier, metaEstadoTM, type CheckpointTM } from '@/lib/trackingmore'

export type TrackingConEstado = {
  id: number
  tramo: string
  numero: string
  transportista: string | null
  courierCode: string | null
  estado: string | null
  subestado: string | null
  ultimoEvento: string | null
  ultimoEventoEn: string | null
  eventos: unknown
  consultadoEn: Date | null
  errorSeguimiento: string | null
}

const horaVe = (d: Date) =>
  d.toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function eventosDe(v: unknown): CheckpointTM[] {
  return Array.isArray(v) ? (v as CheckpointTM[]).filter(e => e && typeof e.detalle === 'string') : []
}

// Lo que TrackingMore dice de cada tracking de la caja (solo lectura). Lo pone al día el timer
// de cada hora (pnpm tracking:sync) o el botón. Ver lib/trackingmore.ts.
export default function SeguimientoCaja({
  trackings,
  activo,
  hayCouriers,
  actualizar,
}: {
  trackings: TrackingConEstado[]
  /** Hay TRACKINGMORE_API_KEY en el servidor. */
  activo: boolean
  hayCouriers: boolean
  actualizar: () => Promise<ActionResult>
}) {
  const ordenados = TRAMOS_TRACKING.flatMap(tramo => trackings.filter(t => t.tramo === tramo))
  const conCourier = trackings.some(t => t.courierCode)

  return (
    <div className="mt-5 pt-4 border-t border-gray-100 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Seguimiento · TrackingMore</h3>
        {activo && (
          <FormConResultado action={actualizar} className="flex flex-col items-end gap-1">
            <PendingButton
              pendingLabel="Consultando…"
              className="px-3 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              ↻ Actualizar ahora
            </PendingButton>
          </FormConResultado>
        )}
      </div>

      {!activo && (
        <p className="text-xs text-gray-400">
          Apagado: falta <code>TRACKINGMORE_API_KEY</code> en el servidor. Los trackings quedan solo anotados.
        </p>
      )}
      {activo && !hayCouriers && (
        <p className="text-xs text-amber-700">
          Todavía no se bajó la lista de couriers. Tocá «Actualizar ahora» y después elegí el courier de cada tracking.
        </p>
      )}
      {activo && hayCouriers && !conCourier && trackings.length > 0 && (
        <p className="text-xs text-gray-400">
          Ningún tracking tiene courier de la lista: elegilo en el buscador de cada tracking para que se siga solo.
        </p>
      )}

      {ordenados.length > 0 && (
        <ul className="space-y-2">
          {ordenados.map(t => {
            const meta = metaEstadoTM(t.estado)
            const eventos = eventosDe(t.eventos)
            const corto = esTramoTracking(t.tramo) ? TRAMO_TRACKING_META[t.tramo].corto : t.tramo
            return (
              <li key={t.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[10px] font-semibold uppercase text-gray-400 w-10">{corto}</span>
                  <span className="font-mono">{t.numero}</span>
                  {t.transportista && <span className="text-xs text-gray-500">{t.transportista}</span>}
                  {!t.courierCode ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">solo anotado</span>
                  ) : t.errorSeguimiento ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700">no se sigue</span>
                  ) : meta ? (
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${meta.color}`} title={t.subestado ?? undefined}>
                      {meta.icon} {meta.label}
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">por consultar</span>
                  )}
                </div>
                {t.courierCode && t.errorSeguimiento && (
                  <p className="ml-12 text-xs text-red-600">{t.errorSeguimiento} Revisá el número o el courier.</p>
                )}
                {t.courierCode && !t.errorSeguimiento && t.ultimoEvento && (
                  <p className="ml-12 text-xs text-gray-600">
                    {t.ultimoEventoEn && <span className="text-gray-400">{fechaCourier(t.ultimoEventoEn)} · </span>}
                    {t.ultimoEvento}
                  </p>
                )}
                {t.courierCode && t.consultadoEn && (
                  <p className="ml-12 text-[10px] text-gray-400">consultado {horaVe(t.consultadoEn)}</p>
                )}
                {eventos.length > 1 && (
                  <details className="ml-12 mt-1">
                    <summary className="text-xs text-blue-600 cursor-pointer">{eventos.length} eventos</summary>
                    <ol className="mt-1 space-y-1 border-l border-gray-200 pl-3">
                      {eventos.map((e, i) => (
                        <li key={i} className="text-xs text-gray-600">
                          <span className="text-gray-400">{fechaCourier(e.fecha)}</span> {e.detalle}
                          {e.lugar && <span className="text-gray-400"> · {e.lugar}</span>}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
