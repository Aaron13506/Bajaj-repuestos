'use client'

import { useEffect, useRef } from 'react'

// El menú "Más" de un pedido: un <details> nativo (teclado y estado expandido gratis) que además
// se cierra al tocar afuera o con Escape. Sus opciones pueden abrir un modal: mientras haya uno
// abierto adentro, Escape es del modal y el menú no se cierra (cerrarlo ocultaría el modal).
export default function MenuMas({ children, etiqueta = 'Más acciones' }: { children: React.ReactNode; etiqueta?: string }) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const cerrar = () => { if (ref.current) ref.current.open = false }
    const hayModal = () => !!ref.current?.querySelector('dialog[open], [aria-modal="true"]')
    const fuera = (e: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node) && !hayModal()) cerrar()
    }
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !ref.current?.open || hayModal()) return
      cerrar()
      ref.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', fuera)
    document.addEventListener('keydown', tecla)
    return () => {
      document.removeEventListener('pointerdown', fuera)
      document.removeEventListener('keydown', tecla)
    }
  }, [])

  return (
    <details ref={ref} className="relative">
      <summary
        aria-label={etiqueta}
        className="list-none [&::-webkit-details-marker]:hidden inline-flex items-center justify-center gap-1.5 min-h-9 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 cursor-pointer"
      >
        Más <span aria-hidden="true">▾</span>
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
        {children}
      </div>
    </details>
  )
}
