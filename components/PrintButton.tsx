'use client'

import { useState } from 'react'
import type { jsPDF } from 'jspdf'

interface PrintButtonProps {
  fileName: string
  onGenerate: () => Promise<jsPDF>
}

export default function PrintButton({ fileName, onGenerate }: PrintButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = async () => {
    setLoading(true)
    setError(null)
    try {
      const doc = await onGenerate()
      doc.save(fileName)
    } catch (e) {
      // Sin esto el click no hacía nada visible: se apagaba el spinner y no bajaba
      // ningún archivo, sin explicación.
      console.error('No se pudo generar el PDF', e)
      setError(e instanceof Error ? e.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      title={error ? `No se pudo generar el PDF: ${error}` : undefined}
      className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg transition-colors disabled:opacity-50 disabled:cursor-wait ${
        error
          ? 'border-red-300 text-red-700 hover:bg-red-50'
          : 'border-gray-300 hover:bg-gray-50'
      }`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
      </svg>
      {loading ? 'Generando PDF...' : error ? 'Falló — reintentar' : 'Descargar PDF'}
    </button>
  )
}
