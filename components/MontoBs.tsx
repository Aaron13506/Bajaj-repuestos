'use client'

import { useEffect, useState, type ReactNode } from 'react'

// Un cobro en bolívares se escribe como pasó: los Bs que entraron al banco. La tasa no se pide:
// es la interna (la BCV en un pedido a BCV, la de cobro directo en el resto, la del libro en un
// egreso) y solo sirve para saber cuántos dólares abona; lo que valen esos Bs de verdad se sabe
// al convertirlos a USDT. Solo si no hay ninguna tasa cargada se escribe a mano. Lo que se guarda
// en el libro son los Bs exactos: es lo que se puede cuadrar contra el estado de cuenta.
//
// Funciona como calculadora: se escriben los Bs y se ve a cuántos dólares equivalen. Con `cierra`,
// el sugerido es el saldo que este pago puede cerrar, y si los Bs no dan justo se elige qué pasa
// con la diferencia: "queda pagado" le acredita el saldo completo (va como `equivalenteUsd`, que
// leerCobroBs ya entiende: "me dieron 15.000 Bs por los $15") o "queda debiendo" / "queda a favor".
// Si sobra y el formulario sabe dar vuelto (`vuelto`), el vuelto es una opción más de la misma
// pregunta: así no se puede "dejarle lo que sobra" y a la vez "darle vuelto".
interface Props {
  /** Tasa a proponer: la del BCV en un pedido a BCV, la de cobro directo en el resto. */
  tasaSugerida: number
  etiquetaTasa: string
  /** Dólares (en la unidad del formulario) que se sugieren cobrar; con la tasa dan unos Bs. */
  sugerido?: number | null
  /** El sugerido es el saldo a cerrar: se ofrece cerrar la diferencia si los Bs no dan justo. */
  cierra?: boolean
  /** Con `inicial` el campo arranca con el sugerido ya convertido a Bs. */
  inicial?: boolean
  /** Cómo llamar a los dólares que salen: "USD a tasa BCV", "USD". */
  unidad: string
  requerido?: boolean
  autoFocus?: boolean
  etiqueta?: string
  /** Para un segundo cobro en el mismo formulario: los campos van como montoBs2/tasaBs2. */
  sufijo?: string
  /** Avisa los dólares que acredita (null = incompleto). */
  onDolares?: (n: number | null) => void
  /** Campos del vuelto, dada la sobra (en la unidad del formulario): ofrece "Le di vuelto" si sobra. */
  vuelto?: (sobra: number) => ReactNode
}

type Opcion = 'cerrar' | 'saldo' | 'vuelto'

// Por debajo de esta parte del saldo la diferencia se propone cerrar sola (igual se puede cambiar).
const DIFERENCIA_CHICA = 0.01

const usd = (n: number) => `$${n.toFixed(2)}`
const bsFmt = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function MontoBs({
  tasaSugerida, etiquetaTasa, sugerido = null, cierra = false, inicial = false, unidad, requerido = false, autoFocus = false,
  etiqueta = 'Bs recibidos', sufijo = '', onDolares, vuelto,
}: Props) {
  const interna = tasaSugerida > 0
  const [tasa, setTasa] = useState(interna ? String(tasaSugerida) : '')
  const [bs, setBs] = useState(() =>
    inicial && sugerido != null && tasaSugerida > 0 ? (Math.round(sugerido * tasaSugerida * 100) / 100).toFixed(2) : '',
  )
  // Lo que eligió para la diferencia, atado al lado en que cayó (falta / sobra): si cambia de
  // lado, vuelve la propuesta por defecto.
  const [eleccion, setEleccion] = useState<{ lado: number; opcion: Opcion } | null>(null)

  const b = parseFloat(bs.replace(',', '.'))
  const t = parseFloat(tasa.replace(',', '.'))
  const calculado = b > 0 && t > 0 ? Math.round((b / t) * 100) / 100 : null
  const saldo = cierra && sugerido != null && sugerido > 0.005 ? sugerido : null
  // Positivo = falta, negativo = sobra (en la unidad del formulario).
  const diferencia = saldo != null && calculado != null ? Math.round((saldo - calculado) * 100) / 100 : null
  const hayDiferencia = diferencia != null && Math.abs(diferencia) >= 0.01
  // La diferencia en Bs se cuenta sobre los Bs escritos, no sobre los dólares ya redondeados.
  const diferenciaBs = saldo != null && b > 0 && t > 0 ? Math.abs(Math.round((saldo * t - b) * 100) / 100) : 0
  const lado = diferencia == null ? 0 : Math.sign(diferencia)
  const porDefecto = hayDiferencia && Math.abs(diferencia!) / saldo! < DIFERENCIA_CHICA
  const opcion: Opcion | null = !hayDiferencia ? null
    : eleccion?.lado === lado && (eleccion.opcion !== 'vuelto' || vuelto) ? eleccion.opcion
    : porDefecto ? 'cerrar' : 'saldo'
  const cerrar = opcion === 'cerrar'
  const dolares = cerrar ? saldo : calculado
  useEffect(() => onDolares?.(dolares), [dolares, onDolares])

  const completo = requerido || bs !== ''
  const cls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-base sm:text-sm tabular-nums focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
  const idAyuda = `montoBs${sufijo}-ayuda`
  const falta = lado > 0
  const opciones: { valor: Opcion; titulo: string; detalle: string }[] = [
    {
      valor: 'cerrar',
      titulo: falta ? 'Queda pagado' : 'Queda pagado (se lo dejo)',
      detalle: falta
        ? `Cierra en $0. La diferencia (Bs ${bsFmt(diferenciaBs)}) la absorbés vos.`
        : 'Cierra en $0; no queda saldo a favor.',
    },
    ...(!falta && vuelto ? [{
      valor: 'vuelto' as const,
      titulo: 'Le di vuelto',
      detalle: 'Anotás lo que le devolviste, por el medio que sea.',
    }] : []),
    {
      valor: 'saldo',
      titulo: falta ? `Queda debiendo ${usd(diferencia ?? 0)}` : `Queda a favor ${usd(-(diferencia ?? 0))}`,
      detalle: falta ? 'Sigue con saldo y lo cobrás después.' : 'Se lo descontás en la próxima compra.',
    },
  ]

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">{etiqueta}</span>
        <div className="flex items-center">
          <span className="text-sm text-gray-500 mr-1.5">Bs</span>
          <input
            type="number" inputMode="decimal" name={`montoBs${sufijo}`} min={0.01} step="0.01" required={requerido} data-autofocus={autoFocus || undefined}
            value={bs} onChange={e => setBs(e.target.value)} aria-describedby={idAyuda} className={`${cls} font-semibold`}
          />
        </div>
      </label>
      {interna ? (
        <input type="hidden" name={`tasaBs${sufijo}`} value={tasa} />
      ) : (
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">{etiquetaTasa} (Bs por USD)</span>
          <input
            type="number" name={`tasaBs${sufijo}`} min={0.0001} step="0.0001" required={completo}
            value={tasa} onChange={e => setTasa(e.target.value)} className={cls}
          />
        </label>
      )}
      {/* "Queda pagado": se le acredita el saldo completo. Vacío = los Bs entre la tasa. */}
      <input type="hidden" name={`equivalenteUsd${sufijo}`} value={cerrar && saldo != null ? saldo.toFixed(2) : ''} />

      <div id={idAyuda} aria-live="polite">
        {calculado != null ? (
          <p className="text-lg font-bold text-gray-900 tabular-nums">
            = {usd(calculado)} <span className="text-xs font-semibold text-gray-500">{unidad}</span>
          </p>
        ) : (
          <p className="text-xs text-gray-500">Escribí los Bs y te digo cuánto es en dólares.</p>
        )}
        <p className="text-xs text-gray-500 tabular-nums">
          {t > 0 && <>{etiquetaTasa} {bsFmt(t)}</>}
          {saldo != null && t > 0 && <> · para cerrar: Bs {bsFmt(saldo * t)}</>}
        </p>
      </div>

      {saldo != null && calculado != null && !hayDiferencia && (
        <p className="text-sm font-medium text-green-800">✓ Cubre el saldo justo.</p>
      )}
      {hayDiferencia && (
        <fieldset className="space-y-2 border-t border-gray-100 pt-2">
          <legend className={`text-sm font-semibold ${falta ? 'text-amber-900' : 'text-blue-900'}`}>
            {falta ? 'Faltan' : 'Sobran'} Bs {bsFmt(diferenciaBs)} ({usd(Math.abs(diferencia!))}). ¿Qué hacemos?
          </legend>
          {opciones.map(o => {
            const elegida = opcion === o.valor
            // Perdonar mucho de golpe suele ser un cero de menos al escribir los Bs.
            const grande = o.valor === 'cerrar' && falta && diferencia! / saldo! > 0.1
            return (
              <div key={o.valor} className="space-y-2">
              <label
                className={`flex items-start gap-2.5 rounded-lg px-3 py-2 text-sm cursor-pointer ${
                  elegida ? 'border-2 border-blue-600 bg-blue-50 text-blue-950' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <input
                  type="radio" name={`cierreBs${sufijo}`} checked={elegida}
                  onChange={() => setEleccion({ lado, opcion: o.valor })}
                  className="mt-0.5 size-4 shrink-0 text-blue-600"
                />
                <span>
                  <span className="block font-semibold">{o.titulo}</span>
                  <span className={`block text-xs ${grande ? 'text-red-700 font-medium' : 'text-gray-600'}`}>
                    {grande ? `Ojo: perdonás ${usd(diferencia!)} (${Math.round((diferencia! / saldo!) * 100)}% del saldo). ¿Faltó un cero?` : o.detalle}
                  </span>
                </span>
              </label>
              {elegida && o.valor === 'vuelto' && <div className="pl-3">{vuelto!(-diferencia!)}</div>}
              </div>
            )
          })}
        </fieldset>
      )}

      {sugerido != null && sugerido > 0 && t > 0 && (
        <button
          type="button" onClick={() => setBs((Math.round(sugerido * t * 100) / 100).toFixed(2))}
          className="min-h-8 text-sm text-blue-700 hover:underline"
        >
          {cierra ? 'Cobrar todo' : 'Poner'} {usd(sugerido)} = Bs {bsFmt(sugerido * t)}
        </button>
      )}
    </div>
  )
}
