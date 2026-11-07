'use client'

import { useEffect, useRef, type ReactNode } from 'react'

// Diálogo modal sobre <dialog> nativo: showModal() deja el fondo inerte, atrapa el foco y
// cierra con Escape. Se monta ya abierto ({open && <Modal …>}); al desmontarse devuelve el foco
// a lo que lo tenía antes (el botón que lo abrió, que por eso tiene que seguir montado). Para
// arrancar en un campo que no es el primero, ese campo lleva data-autofocus (no autoFocus).
//
// Antes cada formulario dibujaba su propio fondo con un <div fixed>: el teclado seguía
// recorriendo la página de atrás, Escape no hacía nada y el lector de pantalla no se enteraba
// de que había un diálogo.
export default function Modal({
  titulo,
  onClose,
  className = '',
  children,
}: {
  /** Nombre del diálogo para el lector de pantalla. */
  titulo: string
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    const previo = document.activeElement as HTMLElement | null
    if (d && !d.open) {
      d.showModal()
      // El autoFocus de React corre con el diálogo todavía cerrado (oculto) y se pierde: el
      // campo que tiene que arrancar con el foco se marca con data-autofocus.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    return () => previo?.focus()
  }, [])

  return (
    <dialog
      ref={ref}
      aria-label={titulo}
      onClose={onClose}
      // Click en el fondo (el ::backdrop cuenta como el propio <dialog>) cierra. No se deja
      // subir el click: varios de estos viven dentro de filas que reaccionan al click.
      onClick={e => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onClose()
      }}
      className={`max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] rounded-xl border border-gray-200 bg-white text-left whitespace-normal shadow-xl backdrop:bg-black/40 ${className}`}
    >
      {children}
    </dialog>
  )
}
