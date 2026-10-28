'use client'

import { useEffect, useState } from 'react'

// Un cobro en bolívares se escribe como pasó: los Bs que entraron al banco. La tasa no se pide:
// es la interna (la BCV en un pedido a BCV, la de cobro directo en el resto, la del libro en un
// egreso) y solo sirve para saber cuántos dólares abona; lo que valen esos Bs de verdad se sabe
// al convertirlos a USDT. Solo si no hay ninguna tasa cargada se escribe a mano. Lo que se guarda
// en el libro son los Bs exactos: es lo que se puede cuadrar contra el estado de cuenta.
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
  /** Para un segundo cobro en el mismo formulario: los campos van como montoBs2/tasaBs2. */
  sufijo?: string
  /** Avisa los dólares que van saliendo (null = incompleto). */
  onDolares?: (n: number | null) => void
}

const usd = (n: number) => `$${n.toFixed(2)}`
const bsFmt = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function MontoBs({
  tasaSugerida, etiquetaTasa, sugerido = null, inicial = false, unidad, requerido = false, autoFocus = false,
  etiqueta = 'Bs recibidos', sufijo = '', onDolares,
}: Props) {
  const interna = tasaSugerida > 0
  const [tasa, setTasa] = useState(interna ? String(tasaSugerida) : '')
  const [bs, setBs] = useState(() =>
    inicial && sugerido != null && tasaSugerida > 0 ? (Math.round(sugerido * tasaSugerida * 100) / 100).toFixed(2) : '',
  )
  // "Me dieron 15.000 Bs por los $15": el equivalente solo dice cuánto se le acredita al cliente.
  // La tasa (y los Bs) quedan como referencia; lo que valen los Bs se mide a tasa USDT.
  const [equiv, setEquiv] = useState('')
  const b = parseFloat(bs)
  const t = parseFloat(tasa)
  const eq = parseFloat(equiv)
  const conEquiv = eq > 0 && b > 0
  const dolares = conEquiv ? eq : b > 0 && t > 0 ? b / t : null
  useEffect(() => onDolares?.(dolares), [dolares, onDolares])
  const completo = requerido || bs !== ''
  const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{etiqueta}</label>
        <div className="flex items-center">
          <span className="text-sm text-gray-400 mr-1">Bs</span>
          <input
            type="number" name={`montoBs${sufijo}`} min={0.01} step="0.01" required={requerido} autoFocus={autoFocus}
            value={bs} onChange={e => setBs(e.target.value)} className={cls}
          />
        </div>
      </div>
      {interna ? (
        <input type="hidden" name={`tasaBs${sufijo}`} value={tasa} />
      ) : (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">{etiquetaTasa} (Bs por USD)</label>
          <input
            type="number" name={`tasaBs${sufijo}`} min={0.0001} step="0.0001" required={completo}
            value={tasa} onChange={e => setTasa(e.target.value)} className={cls}
          />
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Equivale a ({unidad}) <span className="font-normal text-gray-400">opcional</span></label>
        <input
          type="number" name={`equivalenteUsd${sufijo}`} min={0.01} step="0.01" value={equiv} onChange={e => setEquiv(e.target.value)} className={cls}
          placeholder={b > 0 && t > 0 ? (b / t).toFixed(2) : 'Si te lo dieron por un monto redondo'}
        />
      </div>
      <p className="text-[11px] text-gray-500">
        {dolares != null ? <>= <span className="font-mono font-semibold text-gray-700">{usd(dolares)}</span> {unidad}</> : 'Los dólares salen de dividir los Bs entre la tasa.'}
        {conEquiv && t > 0 && (
          // Que se vea cuánto se aparta de la tasa: un typo en el equivalente le acredita de más.
          <span className="text-amber-700"> · a la tasa eran Bs {bsFmt(eq * t)} ({bsFmt(b - eq * t)} Bs de diferencia)</span>
        )}
        {interna && !conEquiv && <span className="text-gray-400"> · {etiquetaTasa.toLowerCase()} {bsFmt(tasaSugerida)}</span>}
      </p>
      {sugerido != null && sugerido > 0 && t > 0 && (
        <button
          type="button" onClick={() => { setBs((Math.round(sugerido * t * 100) / 100).toFixed(2)); setEquiv('') }}
          className="text-[11px] text-blue-600 hover:underline"
        >
          Poner {usd(sugerido)} = Bs {bsFmt(sugerido * t)}
        </button>
      )}
    </div>
  )
}
