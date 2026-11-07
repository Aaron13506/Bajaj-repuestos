'use client'

import { useState, useTransition } from 'react'
import type { ActionResult } from '@/lib/action-result'
import { esRedireccion } from '@/lib/redireccion'

interface DeleteButtonProps {
  // Si devuelve `{ ok: false, error }`, el motivo se le muestra al usuario. Un `throw` en el
  // server llega a producción sin su texto, así que las acciones de borrado que pueden
  // negarse por una regla del negocio devuelven el resultado en vez de tirarlo.
  action: () => Promise<void | ActionResult>
  confirmMessage?: string
  // Para acciones destructivas que no son "eliminar" (ej. deshacer una compra).
  label?: string
  pendingLabel?: string
  /** Nombre completo cuando el botón se repite (una fila de tabla): empieza con el texto visible. */
  ariaLabel?: string
  className?: string
}

export default function DeleteButton({
  action,
  confirmMessage = '¿Confirmas que deseas eliminar este registro?',
  label = 'Eliminar',
  pendingLabel = 'Eliminando...',
  ariaLabel,
  className = '',
}: DeleteButtonProps) {
  const [isPending, startTransition] = useTransition()
  // El motivo se muestra al lado del botón (antes un alert(), que tapaba la página y se perdía).
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    if (!confirm(confirmMessage)) return
    setError(null)
    startTransition(async () => {
      try {
        const r = await action()
        if (r && !r.ok) setError(r.error)
      } catch (e) {
        // Borrar y redirigir (la ficha ya no existe) es el éxito normal, no una falla: ver redireccion.ts.
        if (esRedireccion(e)) return
        setError('No se pudo completar la acción. Probá de nuevo.')
      }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        aria-label={isPending ? undefined : ariaLabel}
        className={`text-red-600 hover:text-red-800 disabled:opacity-40 disabled:cursor-wait text-sm font-medium ${className}`}
      >
        {isPending ? pendingLabel : label}
      </button>
      {error && <span role="alert" className="text-xs text-red-600 whitespace-normal">{error}</span>}
    </>
  )
}
