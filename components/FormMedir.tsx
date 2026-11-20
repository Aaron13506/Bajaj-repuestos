'use client'

import { useState } from 'react'
import { medirPieza } from '@/app/(pages)/products/actions'
import { chequearMedidas, type Chequeo } from '@/lib/measures-check'
import { pesoPorPieza } from '@/lib/medido'
import { toNum } from '@/lib/parse'
import { useEnviarAccion } from './useEnviarAccion'

export interface PiezaAMedir {
  productId: number
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

type Forma = 'caja' | 'bolsa'

// Pesar y medir una pieza con ella en la mano: en el conteo de una caja (ConteoCaja) y en el modo
// Medir del teléfono. Se guarda siempre UNA pieza (lib/medido.ts):
//  · En caja: peso y medidas de la caja con la pieza adentro (base 'empaque').
//  · En bolsa (tornillos, grommets): la bolsa entera a la balanza y se divide por lo que trae; las
//    medidas son de UNA pieza suelta, porque la bolsa es aire (base 'pieza').
// Si la etiqueta leída traía más de 1, arranca en bolsa con esa cantidad. Lo estimado queda de
// referencia. La densidad imposible la rechaza el server (medirPieza); acá se ve antes.
export default function FormMedir({ pieza, unidades, telefono = false, alGuardar, alCancelar, cancelar = 'Ahora no' }: {
  pieza: PiezaAMedir
  /** Lo que traía la etiqueta leída: con más de 1 es una bolsa. */
  unidades: number
  telefono?: boolean
  alGuardar: () => void
  alCancelar: () => void
  cancelar?: string
}) {
  const { enviar, isPending, error } = useEnviarAccion(medirPieza.bind(null, pieza.productId), () => alGuardar())
  const [forma, setForma] = useState<Forma>(unidades > 1 ? 'bolsa' : 'caja')
  const [piezas, setPiezas] = useState(unidades > 1 ? String(unidades) : '')
  const [pesado, setPesado] = useState<number | null>(null)
  const [chequeos, setChequeos] = useState<Chequeo[]>([])
  const porPieza = forma === 'bolsa' && pesado != null ? pesoPorPieza(pesado, Number(piezas)) : pesado

  function revisar(form: HTMLFormElement) {
    const fd = new FormData(form)
    const g = toNum(fd.get('weightGrams'))
    setPesado(g)
    const w = fd.get('forma') === 'bolsa' && g != null ? pesoPorPieza(g, Number(fd.get('piezas'))) : g
    const m = { weightGrams: w, dimL: toNum(fd.get('dimL')), dimA: toNum(fd.get('dimA')), dimH: toNum(fd.get('dimH')) }
    setChequeos([m.weightGrams, m.dimL, m.dimA, m.dimH].every(v => v != null) ? chequearMedidas(m) : [])
  }

  const input = `rounded-md border border-gray-300 bg-white px-2 text-right font-mono ${telefono ? 'min-h-11 w-20 text-base' : 'min-h-8 w-16 text-sm'}`
  const boton = telefono ? 'min-h-11 px-4 text-base' : 'min-h-8 px-3 text-sm'
  const opcion = `flex items-center gap-1.5 rounded-lg border px-3 ${telefono ? 'min-h-11' : 'min-h-8'} text-sm`
  const bolsa = forma === 'bolsa'
  return (
    <form onSubmit={enviar} onInput={e => revisar(e.currentTarget)} className="space-y-2">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Cómo viene</legend>
        {([['caja', 'Viene en caja'], ['bolsa', 'Viene en bolsa']] as const).map(([v, t]) => (
          <label key={v} className={`${opcion} ${forma === v ? 'border-amber-600 bg-amber-50 font-semibold text-amber-900' : 'border-gray-300 text-gray-700'}`}>
            <input type="radio" name="forma" value={v} checked={forma === v} onChange={() => setForma(v)} />
            {t}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-gray-800">
        {bolsa
          ? 'Pesá la bolsa entera y escribí cuántas trae. Las medidas, de UNA pieza suelta.'
          : 'Pesala y medila en su caja, como llegó.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {([['weightGrams', bolsa ? 'g bolsa' : 'g', pieza.weightGrams], ['dimL', 'L cm', pieza.dimL], ['dimA', 'A cm', pieza.dimA], ['dimH', 'H cm', pieza.dimH]] as const).map(([name, label, est]) => (
          <label key={name} className="flex items-center gap-1 text-sm text-gray-700">
            {label}
            {/* type=number y no texto: toNum borra la coma, "12,5" sería 125. */}
            <input name={name} type="number" min={0} step="any" inputMode="decimal" autoComplete="off" required
              placeholder={est != null && !(bolsa && name === 'weightGrams') ? String(est) : ''} className={input} />
          </label>
        ))}
        {bolsa && (
          <label className="flex items-center gap-1 text-sm text-gray-700">
            Trae
            <input name="piezas" type="number" min={1} step={1} inputMode="numeric" required value={piezas} onChange={e => setPiezas(e.target.value)} className={input} />
          </label>
        )}
      </div>
      {bolsa && porPieza != null && <p className="text-xs font-semibold text-amber-800">Se guarda {porPieza.toLocaleString('es-VE')} g por pieza.</p>}
      {(pieza.weightGrams != null || pieza.dimL != null) && (
        <p className="text-xs text-gray-600">
          Estimado por pieza: {pieza.weightGrams ?? '—'} g · {pieza.dimL ?? '—'} × {pieza.dimA ?? '—'} × {pieza.dimH ?? '—'} cm
        </p>
      )}
      {chequeos.map(c => (
        <p key={c.codigo} className={`text-xs ${c.severidad === 'error' ? 'font-semibold text-red-700' : 'text-amber-800'}`}>{c.mensaje}</p>
      ))}
      {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={isPending} className={`${boton} rounded-lg bg-amber-600 font-semibold text-white disabled:opacity-50`}>{isPending ? 'Guardando…' : 'Guardar medida'}</button>
        <button type="button" onClick={alCancelar} className={`${boton} rounded-lg text-gray-700 underline`}>{cancelar}</button>
      </div>
    </form>
  )
}
