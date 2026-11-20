'use client'

import { useEffect, useState } from 'react'

// Chrome avisa que la página se puede instalar con `beforeinstallprompt`. Si el aviso llega antes de
// que React arranque se perdería, así que CAPTURA (en el layout) lo guarda en window apenas carga.
type AvisoInstalar = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
declare global {
  interface Window { __avisoInstalar?: AvisoInstalar | null }
}

export const CAPTURA = `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__avisoInstalar=e;window.dispatchEvent(new Event('avisoinstalar'))});window.addEventListener('appinstalled',function(){window.__avisoInstalar=null;window.dispatchEvent(new Event('avisoinstalar'))});`

// "Instalar app" sin pasar por el menú de Chrome (hay teléfonos donde el menú no la ofrece). Solo
// aparece si Chrome dice que se puede; ya instalada, o en otro navegador, no se muestra.
export default function BotonInstalar() {
  const [aviso, setAviso] = useState<AvisoInstalar | null>(null)
  useEffect(() => {
    const leer = () => setAviso(window.__avisoInstalar ?? null)
    leer()
    window.addEventListener('avisoinstalar', leer)
    return () => window.removeEventListener('avisoinstalar', leer)
  }, [])
  if (!aviso) return null
  return (
    <button
      type="button"
      onClick={async () => {
        await aviso.prompt()
        // Un aviso sirve una sola vez: aceptado o no, Chrome manda otro si vuelve a ofrecerla.
        window.__avisoInstalar = null
        setAviso(null)
      }}
      className="min-h-11 w-full rounded-xl bg-blue-600 px-4 font-semibold text-white"
    >
      Instalar app en este teléfono
    </button>
  )
}
