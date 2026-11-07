'use client'

import { useState, type ReactNode } from 'react'

type Modo = 'ingreso' | 'egreso' | 'usdt'

const MODOS: { valor: Modo; texto: string }[] = [
  { valor: 'ingreso', texto: 'Entra plata' },
  { valor: 'egreso', texto: 'Sale plata' },
  { valor: 'usdt', texto: 'Pasar a USDT' },
]

// Qué se anota en el libro: un ingreso, un egreso o una conversión. Cada uno es su formulario (los
// arma el servidor); se monta solo el elegido, así cambiar de modo arranca el formulario limpio.
export default function AnotarLibro({ paneles }: { paneles: Record<Modo, ReactNode> }) {
  const [modo, setModo] = useState<Modo>('ingreso')

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="sr-only">Qué anotás</legend>
        <div className="grid grid-cols-3 gap-1 p-1 bg-gray-100 rounded-lg max-w-md">
          {MODOS.map(m => (
            <label key={m.valor} className="relative cursor-pointer">
              <input
                type="radio" name="anotar-modo" value={m.valor} checked={modo === m.valor}
                onChange={() => setModo(m.valor)} className="peer sr-only"
              />
              <span className="flex items-center justify-center min-h-10 px-2 text-center rounded-md text-sm font-medium text-gray-600 hover:text-gray-900 peer-checked:bg-white peer-checked:text-gray-900 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-blue-600">
                {m.texto}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {paneles[modo]}
    </div>
  )
}
