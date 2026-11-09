import Sidebar from '@/components/Sidebar'

// En el teléfono el menú pasa arriba (fila con scroll horizontal) para dejarle el ancho a la
// página; desde md vuelve a la columna lateral. h-dvh y no h-screen: en móvil h-screen cuenta la
// barra del navegador y corta el final de la página. `relative` en <main>: sin él, los `sr-only`
// (absolute) se ubican contra el <body> y alargan el documento; scrollear sobre el menú movía esa página.
export default async function PagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row h-dvh bg-gray-50">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 bg-white text-blue-700 font-medium px-3 py-2 rounded-lg shadow"
      >
        Saltar al contenido
      </a>
      <Sidebar />
      <main id="contenido" tabIndex={-1} className="relative flex-1 min-w-0 overflow-auto focus:outline-none">
        <div className="p-4 md:p-8">{children}</div>
      </main>
    </div>
  )
}
