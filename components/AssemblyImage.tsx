'use client'

import { useState } from 'react'

export default function AssemblyImage({ src, name }: { src: string; name: string }) {
  const [downloading, setDownloading] = useState(false)

  // Nombre de archivo: el de la URL original si existe, si no el nombre del producto.
  const filename =
    src.split('/').pop()?.split('?')[0] ||
    `${name.replace(/[^\w\-]+/g, '_').toLowerCase()}.jpg`

  async function download() {
    if (downloading) return
    setDownloading(true)
    try {
      // La imagen es cross-origin (Supabase); se baja como blob para forzar descarga.
      const res = await fetch(src)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      // Si CORS bloquea el fetch, abrimos la imagen en otra pestaña como fallback.
      window.open(src, '_blank', 'noopener')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex justify-end mb-2">
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {downloading ? 'Descargando…' : 'Descargar imagen'}
        </button>
      </div>
      <div className="flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={name} className="max-h-[28rem] w-auto object-contain rounded-lg" />
      </div>
    </div>
  )
}
