'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { cobraEnBolivares } from '@/lib/pagos'
import { METODOS_DEVOLUCION } from '@/lib/devolucion'

// Los campos de "devolverle plata al cliente", que comparten tres formularios (cancelar un pedido,
// devolver un saldo a favor, reembolsar una pieza). Los nombres son los que lee `leerDevolucion`.
//
// El monto se escribe en dólares REALES —lo que sale de caja—. Si se le devuelve en Bs, además se
// anotan los bolívares que se entregaron, tal cual, porque es lo que se cuadra contra el estado de
// cuenta. La tasa no se pide: es Bs ÷ dólares (leerDevolucion).
interface Props {
  /** Lo que se propone devolver. */
  sugerido: number
  /** Lo máximo que se puede devolver (lo cobrado). Sin él, lo controla el server (el vuelto de una entrega). */
  maximo?: number
  /** Tasa de cobro directo, para proponer los Bs. */
  tasaSugerida: number
  /** Texto del campo de monto. */
  etiqueta?: string
  /** Texto de ayuda bajo el monto (por defecto, lo cobrado). */
  ayuda?: string
}

const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

export default function CamposDevolucion({ sugerido, maximo, tasaSugerida, etiqueta = 'Devolver al cliente (USD reales)', ayuda }: Props) {
  const [monto, setMonto] = useState(sugerido > 0 ? sugerido.toFixed(2) : '')
  const [metodo, setMetodo] = useState<string>(METODOS_DEVOLUCION[0])
  const [bs, setBs] = useState('')
  const hay = parseFloat(monto) > 0
  const enBs = hay && cobraEnBolivares(metodo)

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{etiqueta}</label>
        <div className="flex items-center">
          <span className="text-sm text-gray-400 mr-1">$</span>
          <input
            type="number" name="devolverUsd" min={0} max={maximo} step="0.01"
            value={monto} onChange={e => setMonto(e.target.value)}
            className={`${cls} font-mono`}
          />
        </div>
        <p className="text-[11px] text-gray-400 mt-1">
          {ayuda ?? `Tiene cobrado $${(maximo ?? 0).toFixed(2)}. Vacío o 0 = no se devuelve nada.`}
        </p>
      </div>

      {/* El método va siempre a la vista: escondido hasta escribir el monto, un vuelto (que arranca
          vacío) parecía no tener por dónde darse. Sin monto, leerDevolucion lo ignora. */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Se le devuelve por</label>
        <select name="devolverMetodo" value={metodo} onChange={e => setMetodo(e.target.value)} className={cls}>
          {METODOS_DEVOLUCION.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {hay && (
        <>
          {enBs && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Bs entregados</label>
              <input
                type="number" name="devolverBs" min={0.01} step="0.01" required
                placeholder={tasaSugerida > 0 ? (parseFloat(monto) * tasaSugerida).toFixed(2) : undefined}
                value={bs} onChange={e => setBs(e.target.value)} className={`${cls} font-mono`}
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
            <CampoFecha name="devolverFecha" className={cls} />
          </div>
        </>
      )}
    </div>
  )
}
