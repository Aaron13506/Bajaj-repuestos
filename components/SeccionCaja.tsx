import type { ReactNode } from 'react'

// Una sección de la ficha de caja con el encabezado de la pestaña Envío (título, una línea que
// explica y las acciones a la derecha). Solo marcado: sirve igual en el servidor y en el cliente.
export default function SeccionCaja({ id, titulo, sub, acciones, children, className = '' }: {
  id: string
  titulo: ReactNode
  sub?: ReactNode
  acciones?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section aria-labelledby={id} className={`bg-white rounded-xl shadow-sm border border-gray-100 mb-4 ${className}`}>
      <div className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 sm:px-6 py-4 ${children ? 'border-b border-gray-100' : ''}`}>
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-gray-900">{titulo}</h2>
          {sub && <p className="text-sm text-gray-600">{sub}</p>}
        </div>
        {acciones}
      </div>
      {children}
    </section>
  )
}
