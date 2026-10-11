'use client'

import { useState, type ClipboardEvent } from 'react'
import { copiarImagenPegada, subirImagenPegada, type ResultadoImagen } from '@/app/(pages)/products/imagen-actions'

// ─────────────────────────────────────────────────────────────────────────────
// La foto del producto, PEGADA: en la web, clic derecho sobre la imagen → "Copiar imagen",
// y Ctrl+V acá. Sin selector de archivos a propósito: las fotos salen de internet, no de la
// computadora.
//
// Lo que deja el portapapeles depende del navegador y del sitio: casi siempre la imagen
// misma (un PNG), a veces solo su dirección ("Copiar dirección de la imagen", o el HTML de
// la página con un <img>). Se aceptan las dos; la imagen se prefiere porque no depende de que
// el sitio deje bajarla desde el servidor.
//
// Se sube al pegar (ver imagen-actions.ts) y lo que viaja con el formulario es solo la URL
// final, en un input oculto `imageUrl`.
// ─────────────────────────────────────────────────────────────────────────────

// "Copiar imagen" entrega el PNG sin comprimir, que de una foto grande pasa varios MB.
// Se achica en el navegador antes de mandarla: a este tamaño sobra para un presupuesto.
const LADO_MAX = 1600

async function achicar(imagen: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(imagen)
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * escala)
    canvas.height = Math.round(bmp.height * escala)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/webp', 0.85))
    // Un navegador sin WebP devuelve PNG: si encima sale más pesado, va el original.
    return out && out.size < imagen.size ? out : imagen
  } catch {
    return imagen
  }
}

// La dirección de la imagen, si lo pegado no trae la imagen misma.
function direccionPegada(e: ClipboardEvent): string | null {
  const html = e.clipboardData.getData('text/html')
  const src = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src')
  const texto = src || e.clipboardData.getData('text/plain').trim()
  return /^https?:\/\/\S+$/i.test(texto) ? texto : null
}

export default function PegarImagen({ inicial }: { inicial?: string | null }) {
  const [url, setUrl] = useState(inicial ?? '')
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pegar(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault()
    if (subiendo) return
    const archivo = [...e.clipboardData.files].find(f => f.type.startsWith('image/'))
    const direccion = archivo ? null : direccionPegada(e)
    if (!archivo && !direccion) {
      setError('Lo copiado no es una imagen. En la foto: clic derecho → "Copiar imagen".')
      return
    }
    setError(null)
    setSubiendo(true)
    try {
      let r: ResultadoImagen
      if (archivo) {
        const fd = new FormData()
        const blob = await achicar(archivo)
        fd.append('imagen', new File([blob], 'pegada', { type: blob.type }))
        r = await subirImagenPegada(fd)
      } else {
        r = await copiarImagenPegada(direccion!)
      }
      if (r.ok) setUrl(r.url)
      else setError(r.error)
    } catch {
      setError('No se pudo subir la imagen. Probá de nuevo.')
    } finally {
      setSubiendo(false)
    }
  }

  return (
    <div>
      <input type="hidden" name="imageUrl" value={url} />
      <div className="flex items-start gap-3">
        <div
          tabIndex={0}
          onPaste={pegar}
          className="flex h-28 min-w-0 flex-1 cursor-text items-center justify-center rounded-lg border-2 border-dashed border-gray-300 px-3 text-center text-sm text-gray-500 outline-none focus:border-blue-500 focus:bg-blue-50/40"
        >
          {subiendo
            ? 'Subiendo…'
            : <span>Hacé clic acá y pegá la foto con <kbd className="rounded border border-gray-300 bg-gray-50 px-1 font-mono text-xs">Ctrl+V</kbd><br />
                <span className="text-xs text-gray-400">En la web: clic derecho sobre la imagen → &quot;Copiar imagen&quot;</span></span>}
        </div>
        {url && (
          <div className="flex shrink-0 flex-col items-center gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-28 w-28 rounded-lg border border-gray-200 bg-white object-contain" />
            <button type="button" onClick={() => { setUrl(''); setError(null) }}
              className="text-xs text-gray-500 hover:text-red-600">
              Quitar
            </button>
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
