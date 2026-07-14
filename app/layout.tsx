import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

// Toda la app lee datos en vivo de la BD (herramienta de admin tras Basic Auth).
// No hay beneficio en generación estática y sí un bug grave: las páginas sin API
// dinámica (/, /groups, /presupuestos, /envios) quedaban congeladas con los datos
// del build. Forzar render dinámico hace que cada request consulte la BD fresca.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Bajaj Repuestos',
  description: 'Sistema de gestion de repuestos Bajaj',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
