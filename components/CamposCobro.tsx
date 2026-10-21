'use client'

import { useState } from 'react'
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
}

const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

export default function CamposCobro({ methods, modoBcv, saldo, tasaBs, requerido = true, conSaldo = false }: Props) {
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
            inicial={conSaldo}
            unidad={unidad}
            requerido={requerido}
            autoFocus
          />
        ) : (
          <>
            <label className="block text-xs font-medium text-gray-600 mb-1">Monto ({unidad})</label>
            <div className="flex items-center">
              <span className="text-sm text-gray-400 mr-1">$</span>
              <input
                type="number" name="monto" min={requerido ? 0.01 : 0} step="0.01" required={requerido} autoFocus
                value={monto} onChange={e => setMonto(e.target.value)}
                className={`${cls} font-mono`}
              />
            </div>
          </>
        )}
        {saldoMetodo > 0.005 && (
          <p className="text-[11px] text-gray-400 mt-1">
            Saldo: ${saldoMetodo.toFixed(2)}{modoBcv && (enBs ? ' a tasa BCV' : ' en divisas')}
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
        <select name="metodoPago" value={metodo} onChange={e => setMetodo(e.target.value)} className={cls}>
          {methods.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
    </>
  )
}
