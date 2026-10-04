'use client'

import { useFormStatus } from 'react-dom'

// Botón de submit que se deshabilita y cambia el texto mientras el server action está en
// vuelo. La base vive en Supabase remoto, así que cada acción tarda cientos de ms: sin
// esto el botón parece muerto y se lo clickea dos veces.
//
// Tiene que estar DENTRO del <form> para que useFormStatus lo vea.
//
// `confirmMessage` pide confirmación antes de enviar (acciones que mueven stock o estado y
// no son un "eliminar", que ya tiene DeleteButton). Cancelar el diálogo cancela el submit.
export default function PendingButton({
  children,
  pendingLabel,
  className = '',
  formAction,
  confirmMessage,
  title,
  disabled = false,
}: {
  children: React.ReactNode
  pendingLabel?: string
  className?: string
  formAction?: (formData: FormData) => void | Promise<void>
  confirmMessage?: string
  title?: string
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending || disabled}
      title={title}
      onClick={confirmMessage ? e => { if (!confirm(confirmMessage)) e.preventDefault() } : undefined}
      className={`disabled:opacity-50 disabled:cursor-wait ${className}`}
    >
      {pending ? (pendingLabel ?? 'Guardando…') : children}
    </button>
  )
}
