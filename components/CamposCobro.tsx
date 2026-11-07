'use client'

import { useState, type ReactNode } from 'react'
import { cobraEnBolivares } from '@/lib/pagos'
import MontoBs from '@/components/MontoBs'

// Monto y método de un pago de cliente, con los nombres que leen registrarPagoPedido y
// confirmarEntrega (`monto`, `metodoPago`, y `montoBs`/`tasaBs` si fue en Bs).
interface Props {
  methods: readonly string[]
  /** Pedido a dólar BCV: lo cobrado en Bs se escribe en dólares BCV, lo demás en divisas. */
  modoBcv: boolean
  /** Lo que falta, en las dos monedas (iguales si el pedido no es a BCV). */
  saldo: { bs: number; divisas: number }
  /** Tasa con la que se anotan los Bs de un cobro en bolívares. */
  tasaBs: { valor: number; etiqueta: string }
  /** false = se puede dejar vacío (en la entrega puede no pagar nada). */
  requerido?: boolean
  /** Arranca con el saldo escrito (en divisas). */
  conSaldo?: boolean
  /** Campos del vuelto, dados los dólares reales que sobran. En Bs es una opción de MontoBs; en
   *  divisas, una casilla "Le di vuelto". Sin él, no se ofrece vuelto. */
  vuelto?: (sobraReal: number) => ReactNode
}

const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

export default function CamposCobro({ methods, modoBcv, saldo, tasaBs, requerido = true, conSaldo = false, vuelto }: Props) {
  const [conVuelto, setConVuelto] = useState(false)
  const [metodo, setMetodo] = useState<string>(methods[0])
  const [monto, setMonto] = useState(conSaldo && saldo.divisas > 0.005 ? saldo.divisas.toFixed(2) : '')
  const enBs = cobraEnBolivares(metodo)
  const unidad = !modoBcv ? 'USD' : enBs ? 'USD a tasa BCV' : 'USD en divisas'
  const saldoMetodo = enBs ? saldo.bs : saldo.divisas

  return (
    <>
      <div>
        {enBs ? (
          <MontoBs
            key="bs"
            tasaSugerida={tasaBs.valor}
            etiquetaTasa={tasaBs.etiqueta}
            sugerido={saldoMetodo > 0.005 ? saldoMetodo : null}
            cierra
            inicial={conSaldo}
            // Dólares del formulario → reales, con la proporción del propio saldo (BCV → divisas).
            vuelto={vuelto && (s => vuelto(Math.floor(s * (saldo.bs > 0 ? saldo.divisas / saldo.bs : 1) * 100) / 100))}
            unidad={unidad}
            requerido={requerido}
            autoFocus
          />
        ) : (
          <>
            <label className="block text-xs font-medium text-gray-600 mb-1">Monto ({unidad})</label>
            <div className="flex items-center">
              <span className="text-sm text-gray-500 mr-1">$</span>
              <input
                type="number" name="monto" min={requerido ? 0.01 : 0} step="0.01" required={requerido} data-autofocus
                value={monto} onChange={e => setMonto(e.target.value)}
                className={`${cls} font-mono`}
              />
            </div>
          </>
        )}
        {/* En Bs, MontoBs ya dice cuánto falta para cerrar. */}
        {!enBs && saldoMetodo > 0.005 && (
          <p className="text-[11px] text-gray-500 mt-1">
            Saldo: ${saldoMetodo.toFixed(2)}{modoBcv && (enBs ? ' a tasa BCV' : ' en divisas')}
          </p>
        )}
      </div>

      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">Método de pago</span>
        <select name="metodoPago" value={metodo} onChange={e => setMetodo(e.target.value)} className={cls}>
          {methods.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      {vuelto && !enBs && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={conVuelto} onChange={e => setConVuelto(e.target.checked)} className="rounded border-gray-300" />
            Le di vuelto
          </label>
          {conVuelto && vuelto(Math.max(0, Math.round(((parseFloat(monto) || 0) - saldo.divisas) * 100) / 100))}
        </div>
      )}
    </>
  )
}
