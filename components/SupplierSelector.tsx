'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setActiveSupplier } from '@/app/(pages)/suppliers/actions'

interface SupplierOption {
  id: number
  name: string
}

interface Props {
  suppliers: SupplierOption[]
  activeSupplierId: number | null
}

export default function SupplierSelector({ suppliers, activeSupplierId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    const supplierId = value ? parseInt(value) : null
    startTransition(async () => {
      await setActiveSupplier(supplierId)
      router.refresh()
    })
  }

  return (
    <div className="mt-3">
      <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        Precios de
      </label>
      <select
        defaultValue={activeSupplierId ?? ''}
        onChange={handleChange}
        disabled={isPending}
        className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
      >
        <option value="">99rpm (base)</option>
        {suppliers.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  )
}
