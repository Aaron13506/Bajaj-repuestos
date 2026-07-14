'use client'

import { useTransition } from 'react'

interface DeleteButtonProps {
  action: () => Promise<void>
  confirmMessage?: string
}

export default function DeleteButton({
  action,
  confirmMessage = '¿Confirmas que deseas eliminar este registro?',
}: DeleteButtonProps) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    if (confirm(confirmMessage)) {
      startTransition(() => action())
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="text-red-600 hover:text-red-800 disabled:opacity-40 text-sm font-medium"
    >
      {isPending ? 'Eliminando...' : 'Eliminar'}
    </button>
  )
}
