'use client'

import { useState } from 'react'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import Modal from '@/components/Modal'
import CamposDevolucion from '@/components/CamposDevolucion'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  /** Lo que se puede devolver: el saldo a favor del cliente (o lo cobrado, en un pedido cancelado). */
  maximo: number
  tasaSugerida: number
}

// Le devuelve al cliente lo que tiene de más. Es el segundo paso de editar un pedido a la baja: el
// sistema no devuelve solo, porque eso se acuerda con el cliente.
export default function DevolverClienteForm({ action, maximo, tasaSugerida }: Props) {
  const [open, setOpen] = useState(false)
  const { enviar, isPending, error, limpiarError } = useEnviarAccion(action, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        onClick={() => { limpiarError(); setOpen(true) }}
        className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Devolver al cliente
      </button>
      {open && (
        <Modal titulo="Devolverle plata al cliente" onClose={() => setOpen(false)} className="w-80">
          <form onSubmit={enviar} className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Devolverle plata al cliente</h2>
            <CamposDevolucion sugerido={maximo} maximo={maximo} tasaSugerida={tasaSugerida} etiqueta="Monto a devolver (USD reales)" />
            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
            <div className="flex items-center gap-2 pt-1">
              <button type="submit" disabled={isPending} className="flex-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
                {isPending ? 'Guardando…' : 'Registrar devolución'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50">
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
