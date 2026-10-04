'use client'

import { useState, type ReactNode } from 'react'
import type { ActionResult } from '@/lib/action-result'

// Un <form> para una server action que puede negarse por una regla del negocio y devolver
// `{ ok: false, error }`. Con un `<form action={accion}>` pelado ese resultado se pierde: el
// form no tiene dónde mostrarlo y el rechazo es indistinguible de un éxito. Sigue siendo un
// form con `action`, así que `PendingButton` (useFormStatus) funciona adentro tal cual.
export default function FormConResultado({
  action,
  className,
  children,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>
  className?: string
  children: ReactNode
}) {
  const [error, setError] = useState<string | null>(null)

  async function enviar(formData: FormData) {
    setError(null)
    try {
      const r = await action(formData)
      if (r && !r.ok) setError(r.error)
    } catch {
      setError('No se pudo completar la acción. Probá de nuevo.')
    }
  }

  return (
    <form action={enviar} className={className}>
      {children}
      {error && (
        <p role="alert" className="basis-full col-span-full text-xs text-red-600">
          {error}
        </p>
      )}
    </form>
  )
}
