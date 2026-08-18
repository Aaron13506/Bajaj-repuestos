'use client'

import { useTransition } from 'react'
import { cambiarProveedor } from '@/app/(pages)/envios/linea-actions'

// Proveedor de ESTE embarque. Vive en la caja y no en el sidebar porque es un dato de la
// compra, no una preferencia de pantalla: decide el precio de cada pieza y el FOB, y queda
// congelado al cerrarla. Un selector global daba la ilusión contraria — que cambiándolo se
// re-costeaba lo que estabas mirando, cuando en realidad no tocaba nada.

interface Props {
  envioId: number
  supplierId: number | null
  suppliers: { id: number; name: string; fobUsd: number | null }[]
  fobEfectivoUsd: number
  editable: boolean
}

export default function SelectorProveedorEmbarque({
  envioId, supplierId, suppliers, fobEfectivoUsd, editable,
}: Props) {
  const [pending, startTransition] = useTransition()
  const actual = suppliers.find(s => s.id === supplierId)

  if (!editable) {
    return (
      <span
        className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600"
        title="Proveedor con el que se compró este embarque"
      >
        {actual?.name ?? '99rpm (base)'} · FOB ${fobEfectivoUsd.toFixed(2)}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs bg-gray-100 rounded-full pl-2.5 pr-1 py-0.5">
      <span className="text-gray-500">Proveedor</span>
      <select
        value={supplierId ?? ''}
        disabled={pending}
        onChange={e => {
          const v = e.target.value
          startTransition(() => { cambiarProveedor(envioId, v === '' ? null : parseInt(v)) })
        }}
        className="bg-white border border-gray-300 rounded-full px-2 py-0.5 text-xs font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
        title="Define el precio de cada pieza y el FOB de este embarque"
      >
        <option value="">99rpm (base ₹)</option>
        {suppliers.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}{s.fobUsd != null ? ` · FOB $${s.fobUsd.toFixed(0)}` : ''}
          </option>
        ))}
      </select>
      <span className="text-gray-500 pr-1.5">FOB ${fobEfectivoUsd.toFixed(0)}</span>
    </span>
  )
}
