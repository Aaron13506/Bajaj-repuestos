'use client'

import { useState } from 'react'
import PrintButton from '@/components/PrintButton'
import { normUbicacion, UBICACION_MAX } from '@/lib/qr-bajaj'

// Una ubicación por línea (o separadas por coma), normalizadas como se guardan ("a 3" → "A-3").
export default function EtiquetasEstante({ inicial }: { inicial: string[] }) {
  const [texto, setTexto] = useState(inicial.join('\n'))
  const todas = texto.split(/[\n,;]+/).map(normUbicacion).filter((u): u is string => u != null)
  const largas = todas.filter(u => u.length > UBICACION_MAX)
  const ubicaciones = [...new Set(todas)].filter(u => u.length <= UBICACION_MAX)
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
      <label className="block text-sm">
        <span className="font-medium text-gray-900">Estantes</span>
        <span className="block text-gray-600">Uno por línea: A-1, A-2, B-1…</span>
        <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={8} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" />
      </label>
      {largas.length > 0 && <p role="alert" className="text-sm text-red-700">Muy largas (hasta {UBICACION_MAX} caracteres), no se imprimen: {largas.join(', ')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-gray-600 flex-1">{ubicaciones.length} {ubicaciones.length === 1 ? 'etiqueta' : 'etiquetas'} · A4, 21 por hoja (70 × 42 mm)</p>
        {ubicaciones.length > 0 && (
          <PrintButton fileName="etiquetas-estante.pdf" onGenerate={async () => (await import('@/lib/pdf/etiquetas-pdf')).buildEtiquetasPdf(ubicaciones)} />
        )}
      </div>
    </div>
  )
}
