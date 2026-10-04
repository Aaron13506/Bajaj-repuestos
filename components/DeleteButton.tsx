'use client'

import { useTransition } from 'react'
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
}

export default function DeleteButton({
  action,
  confirmMessage = '¿Confirmas que deseas eliminar este registro?',
  label = 'Eliminar',
  pendingLabel = 'Eliminando...',
}: DeleteButtonProps) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    if (!confirm(confirmMessage)) return
    startTransition(async () => {
      try {
        const r = await action()
        if (r && !r.ok) alert(r.error)
      } catch (e) {
        // Borrar y redirigir (la ficha ya no existe) es el éxito normal, no una falla: ver redireccion.ts.
        if (esRedireccion(e)) return
        alert('No se pudo completar la acción. Probá de nuevo.')
      }
    })
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="text-red-600 hover:text-red-800 disabled:opacity-40 text-sm font-medium"
    >
      {isPending ? pendingLabel : label}
    </button>
  )
}
