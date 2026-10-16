'use client'

import { useState } from 'react'

// Un cobro en bolívares se escribe como pasó: los Bs que entraron al banco y la tasa (Bs por
// dólar) de ESE día. Los dólares salen de dividir —en un pedido a dólar BCV son dólares BCV; en
// el resto, reales— y se muestran para que se vea lo que va a quedar. Lo que se guarda en el
// libro son los Bs exactos: es lo que se puede cuadrar contra el estado de cuenta.
interface Props {
  /** Tasa a proponer: la del BCV en un pedido a BCV, la de cobro directo en el resto. */
  tasaSugerida: number
  etiquetaTasa: string
  /** Dólares (en la unidad del formulario) que se sugieren cobrar; con la tasa dan unos Bs. */
  sugerido?: number | null
  /** Con `inicial` el campo arranca con el sugerido ya convertido a Bs. */
  inicial?: boolean
  /** Cómo llamar a los dólares que salen: "USD a tasa BCV", "USD". */
  unidad: string
  requerido?: boolean
  autoFocus?: boolean
  etiqueta?: string
}

const usd = (n: number) => `$${n.toFixed(2)}`
const bsFmt = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function MontoBs({
  tasaSugerida, etiquetaTasa, sugerido = null, inicial = false, unidad, requerido = false, autoFocus = false,
  etiqueta = 'Bs recibidos',
}: Props) {
  const [tasa, setTasa] = useState(tasaSugerida > 0 ? tasaSugerida.toFixed(2) : '')
  const [bs, setBs] = useState(() =>
    inicial && sugerido != null && tasaSugerida > 0 ? (Math.round(sugerido * tasaSugerida * 100) / 100).toFixed(2) : '',
  )
  const b = parseFloat(bs)
  const t = parseFloat(tasa)
  const dolares = b > 0 && t > 0 ? b / t : null
  const completo = requerido || bs !== ''
  const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{etiqueta}</label>
        <div className="flex items-center">
          <span className="text-sm text-gray-400 mr-1">Bs</span>
          <input
            type="number" name="montoBs" min={0.01} step="0.01" required={requerido} autoFocus={autoFocus}
            value={bs} onChange={e => setBs(e.target.value)} className={cls}
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{etiquetaTasa} (Bs por USD)</label>
        <input
          type="number" name="tasaBs" min={0.0001} step="0.0001" required={completo}
          value={tasa} onChange={e => setTasa(e.target.value)} className={cls}
        />
      </div>
      <p className="text-[11px] text-gray-500">
        {dolares != null ? <>= <span className="font-mono font-semibold text-gray-700">{usd(dolares)}</span> {unidad}</> : 'Los dólares salen de dividir los Bs entre la tasa.'}
      </p>
      {sugerido != null && sugerido > 0 && t > 0 && (
        <button
          type="button" onClick={() => setBs((Math.round(sugerido * t * 100) / 100).toFixed(2))}
          className="text-[11px] text-blue-600 hover:underline"
        >
          Poner {usd(sugerido)} = Bs {bsFmt(sugerido * t)}
        </button>
      )}
    </div>
  )
}
