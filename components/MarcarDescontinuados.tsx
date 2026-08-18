'use client'

import { useState, useTransition } from 'react'
import { marcarDescontinuados, type ResultadoMarcado } from '@/app/(pages)/products/discontinued/actions'

// Carga en lote de piezas descontinuadas, pegando códigos Bajaj.
//
// Las dos acciones están a la vista y separadas (no un toggle): marcar y desmarcar hacen
// cosas opuestas sobre una lista que ya pegaste, y un switch mal leído aplicaría lo
// contrario a decenas de piezas de una. Desmarcar además es la operación rara —
// resucitar un SKU — y conviene que cueste un click deliberado.

export default function MarcarDescontinuados() {
  const [texto, setTexto] = useState('')
  const [res, setRes] = useState<ResultadoMarcado | null>(null)
  const [pending, startTransition] = useTransition()

  const enviar = (accion: 'marcar' | 'desmarcar') => {
    startTransition(async () => {
      const r = await marcarDescontinuados(texto, accion)
      setRes(r)
      // El texto se conserva a propósito: si algunos códigos no se encontraron, querés
      // verlos contra lo que pegaste para corregirlos, no volver a empezar.
    })
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
      <div>
        <label htmlFor="codigos" className="block font-semibold text-gray-900 mb-1">
          Códigos Bajaj
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Uno por línea, o separados por coma o espacio. Se cruzan también por el código alterno: si la pieza
          está cargada con el otro número del par, igual la encuentra.
        </p>
        <textarea
          id="codigos"
          value={texto}
          onChange={e => setTexto(e.target.value)}
          rows={10}
          placeholder={'GL131827\nDJ191026\nJL581023'}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => enviar('marcar')}
          disabled={pending || texto.trim() === ''}
          className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Aplicando…' : 'Marcar como descontinuadas'}
        </button>
        <button
          type="button"
          onClick={() => enviar('desmarcar')}
          disabled={pending || texto.trim() === ''}
          title="Volver a habilitarlas: solo si confirmaste que la fábrica las produce de nuevo"
          className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Quitar la marca
        </button>
      </div>

      {res && (
        <div className="border-t border-gray-100 pt-4 space-y-2">
          <p className="text-sm text-gray-700">
            <span className="font-semibold">{res.cambiados}</span> pieza{res.cambiados === 1 ? '' : 's'} actualizada
            {res.cambiados === 1 ? '' : 's'} de {res.leidos} código{res.leidos === 1 ? '' : 's'} leído
            {res.leidos === 1 ? '' : 's'}
            {res.sinCambio > 0 && <span className="text-gray-500"> · {res.sinCambio} ya estaba{res.sinCambio === 1 ? '' : 'n'} así</span>}
          </p>
          {res.noEncontrados.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <p className="text-sm text-amber-900 font-semibold mb-1">
                {res.noEncontrados.length} código{res.noEncontrados.length === 1 ? '' : 's'} sin pieza en el catálogo
              </p>
              <p className="text-xs text-amber-800 mb-2">
                No existen con ese número ni con el alterno. No se marcó nada por ellos — revisá si están bien
                tipeados o si esa pieza nunca se cargó.
              </p>
              <p className="font-mono text-xs text-amber-900 break-all">{res.noEncontrados.join(' · ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
