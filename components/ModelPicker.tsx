'use client'

import { useState } from 'react'
import { ALL_MODELS, formatModels, type MotoModelId } from '@/lib/modelo'

interface Props {
  /** Motos ya marcadas. */
  value: readonly string[]
  /** Nombre del campo en el form; se manda un valor por moto marcada. */
  name?: string
  /** Compacto para el modal de edición rápida. */
  dense?: boolean
}

/**
 * Selector de las motos de una pieza. Reemplaza al viejo input de texto libre: ahí se
 * podía escribir "Pulsar N250/N160", que no es ninguno de los 15 modelos y no servía
 * para cruzar compatibilidad. Acá solo se puede elegir de la lista.
 *
 * Agrupado por familia con un atajo por fila, porque así se carga de verdad: una pieza
 * que sirve para "las N250" son sus tres variantes, no tres clics sueltos.
 */
export default function ModelPicker({ value, name = 'models', dense = false }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(value))

  const families = [...new Set(ALL_MODELS.map(m => m.family))]

  function toggle(id: MotoModelId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleFamily(family: string) {
    const ids = ALL_MODELS.filter(m => m.family === family).map(m => m.id)
    const allOn = ids.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) allOn ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div>
      {/* El form manda un valor por moto marcada; sin ninguna, no manda nada y el
          server action lo lee como lista vacía. */}
      {[...selected].map(id => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}

      <div className={`border border-gray-300 rounded-lg divide-y divide-gray-100 ${dense ? 'text-xs' : 'text-sm'}`}>
        {families.map(family => {
          const inFamily = ALL_MODELS.filter(m => m.family === family)
          const allOn = inFamily.every(m => selected.has(m.id))
          return (
            <div key={family} className={`flex items-start gap-2 ${dense ? 'px-2 py-1.5' : 'px-3 py-2'}`}>
              <button
                type="button"
                onClick={() => toggleFamily(family)}
                title={allOn ? `Desmarcar todas las ${family}` : `Marcar todas las ${family}`}
                className={`shrink-0 font-semibold text-left w-14 ${allOn ? 'text-blue-600' : 'text-gray-500 hover:text-gray-800'}`}
              >
                {family}
              </button>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {inFamily.map(m => (
                  <label key={m.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600"
                    />
                    <span className={selected.has(m.id) ? 'text-gray-900' : 'text-gray-500'}>
                      {m.variant}
                      {m.years && <span className="text-gray-400"> {m.years}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <p className={`mt-1 text-gray-400 ${dense ? 'text-[10px]' : 'text-xs'}`}>
        {selected.size === 0
          ? 'Sin motos — la pieza no va a aparecer en ningún filtro por moto.'
          : formatModels([...selected])}
      </p>
    </div>
  )
}
