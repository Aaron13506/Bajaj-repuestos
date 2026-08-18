'use client'

import { useState } from 'react'

// Botón de "copiar como JSON" con su plan B.
//
// El portapapeles falla en silencio más seguido de lo que uno cree (http sin TLS, permiso
// denegado, iframe): cuando eso pasa, el botón que dice "✓ Copiado" miente y uno se entera
// al pegar. Por eso el fallback no es opcional — si no se pudo copiar, se muestra el texto
// para sacarlo a mano.
//
// El JSON se arma en el click y no antes (`obtener` es una función): en el armador el
// contenido cambia con cada tecla, y serializarlo en cada render sería trabajo tirado.

export default function CopiarJson({
  obtener,
  label,
  title,
  disabled,
  className = 'border border-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
}: {
  /** Se llama en el click. Lo que devuelva se serializa con indentación de 2. */
  obtener: () => unknown
  label: string
  title?: string
  disabled?: boolean
  className?: string
}) {
  const [copiado, setCopiado] = useState(false)
  const [manual, setManual] = useState<string | null>(null)

  const copiar = async () => {
    const texto = JSON.stringify(obtener(), null, 2)
    try {
      await navigator.clipboard.writeText(texto)
      setManual(null)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      setManual(texto)
    }
  }

  return (
    <>
      <button type="button" onClick={copiar} disabled={disabled} title={title} className={className}>
        {copiado ? '✓ Copiado' : label}
      </button>
      {manual && (
        <div className="mt-3 w-full">
          <p className="text-xs text-amber-700 mb-1">
            El navegador no dejó copiar automáticamente. Seleccioná el texto y copialo a mano:
          </p>
          <textarea
            readOnly
            value={manual}
            onFocus={e => e.currentTarget.select()}
            rows={10}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-[11px] text-gray-700"
          />
        </div>
      )}
    </>
  )
}
