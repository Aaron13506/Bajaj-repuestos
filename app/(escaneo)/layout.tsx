import type { Viewport } from 'next'

export const viewport: Viewport = { themeColor: '#111827' }

// La pantalla del teléfono (/escanear): sin el Sidebar de (pages), a pantalla completa y
// pensada para una mano.
export default function EscaneoLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-dvh bg-gray-50">{children}</main>
}
