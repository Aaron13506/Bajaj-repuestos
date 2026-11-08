'use client'

import { useAccionDirecta } from '@/components/useEnviarAccion'
import { marcarNovedadesVistas } from '@/app/(pages)/actions'

// «Ya lo vi» de las novedades del inicio: marca como vistas las que están en pantalla.
export default function YaLoVi({ vistos }: { vistos: { id: number; clave: string }[] }) {
  const { pending, error, ejecutar } = useAccionDirecta()
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => ejecutar(() => marcarNovedadesVistas(vistos))}
        className="inline-flex items-center justify-center min-h-10 px-4 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60 disabled:cursor-wait"
      >
        {pending ? 'Guardando…' : 'Ya lo vi'}
      </button>
      {error && <p role="alert" className="text-xs text-red-700 max-w-xs text-right">{error}</p>}
    </div>
  )
}
