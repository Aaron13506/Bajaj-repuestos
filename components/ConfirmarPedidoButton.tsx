'use client'

import { useTransition } from 'react'

interface Props {
  action: () => Promise<void>
}

export default function ConfirmarPedidoButton({ action }: Props) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    if (confirm('¿Confirmar este presupuesto como pedido oficial? Ya no podrá editarse.')) {
      startTransition(() => action())
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
    >
      {isPending ? 'Confirmando...' : 'Confirmar pedido'}
    </button>
  )
}
