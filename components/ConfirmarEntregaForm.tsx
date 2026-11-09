'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import CamposCobro from '@/components/CamposCobro'
import CamposDevolucion from '@/components/CamposDevolucion'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import type { ActionResult } from '@/lib/action-result'

export interface LineaEntrega {
  id: number
  nombre: string
  quantity: number
  /** Por qué no se puede entregar todavía (null = está recibida y lista). */
  motivo: string | null
}

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  lineas: LineaEntrega[]
  methods: readonly string[]
  modoBcv: boolean
  saldo: { bs: number; divisas: number }
  tasaBs: { valor: number; etiqueta: string }
  /** Tasa de cobro directo, para proponer los Bs de un vuelto. */
  tasaDevolucion: number
  /** Texto y clases del botón que abre el formulario (por defecto, los de siempre). */
  etiqueta?: React.ReactNode
  claseBoton?: string
}

const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

// El cliente se lleva lo recibido: qué piezas, lo que pagó en ese momento y el vuelto, en un solo
// paso (ver confirmarEntrega). Las piezas pasan a entregado solas, estén en una caja o en el depósito.
export default function ConfirmarEntregaForm({ action, lineas, methods, modoBcv, saldo, tasaBs, tasaDevolucion, etiqueta, claseBoton }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))
  const debe = saldo.divisas > 0.005

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className={claseBoton ?? "px-3 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"}
      >
        {etiqueta ?? '✅ Confirmar entrega'}
      </button>
      {open && (
        <Modal titulo="Confirmar entrega" onClose={() => setOpen(false)} className="w-96 max-w-full">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Confirmar entrega</h2>

            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-gray-600 mb-1">Qué se lleva</legend>
              {lineas.map(l => (
                <label key={l.id} className={`flex items-start gap-2 text-sm ${l.motivo ? 'text-gray-500' : 'text-gray-800'}`}>
                  <input type="checkbox" name="itemId" value={l.id} defaultChecked={!l.motivo} disabled={!!l.motivo} className="mt-0.5 rounded border-gray-300" />
                  <span>
                    {l.quantity > 1 && <span className="font-mono text-xs">{l.quantity}× </span>}
                    {l.nombre}
                    {l.motivo && <span className="block text-[11px]">{l.motivo}</span>}
                  </span>
                </label>
              ))}
            </fieldset>

            {debe ? (
              <div className="space-y-3 pt-2 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-600">Lo que pagó ahora <span className="font-normal text-gray-500">(vacío si no pagó nada)</span></p>
                <CamposCobro
                  methods={methods} modoBcv={modoBcv} saldo={saldo} tasaBs={tasaBs} requerido={false} conSaldo
                  vuelto={sobra => (
                    <CamposDevolucion
                      key={sobra.toFixed(2)}
                      sugerido={sobra}
                      tasaSugerida={tasaDevolucion}
                      etiqueta="Vuelto (USD reales)"
                      ayuda="Lo que le devolviste porque pagó de más. Puede ser por otro medio que el pago."
                    />
                  )}
                />
              </div>
            ) : (
              <p className="text-xs text-green-700 pt-2 border-t border-gray-100">Ya está pagado completo.</p>
            )}

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Fecha</span>
              <CampoFecha name="fecha" className={cls} />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Nota (opcional)</span>
              <input type="text" name="descripcion" placeholder="Retiró en persona, delivery…" className={cls} />
            </label>

            {debe && (
              <label className="flex items-start gap-2 text-xs text-gray-600">
                <input type="checkbox" name="entregarConSaldo" className="mt-0.5 rounded border-gray-300" />
                Si no cubre el saldo, entregar igual (queda anotado en el historial)
              </label>
            )}

            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Guardando…' : 'Confirmar entrega'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
