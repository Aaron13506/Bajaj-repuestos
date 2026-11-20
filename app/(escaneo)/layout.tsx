import type { Viewport } from 'next'
import { CAPTURA } from '@/components/BotonInstalar'

export const viewport: Viewport = { themeColor: '#111827' }

// La pantalla del teléfono (/escanear): sin el Sidebar de (pages), a pantalla completa y
// pensada para una mano.
export default function EscaneoLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-gray-50">
      {/* Antes que React: guarda el aviso de Chrome de que se puede instalar (components/BotonInstalar). */}
      <script dangerouslySetInnerHTML={{ __html: CAPTURA }} />
      {children}
    </main>
  )
}
