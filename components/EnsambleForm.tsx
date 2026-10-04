'use client'

import Link from 'next/link'
import ModelPicker from '@/components/ModelPicker'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import type { ActionResult } from '@/lib/action-result'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  submitLabel: string
  cancelHref: string
  defaultValues?: {
    nameEs?: string | null
    nameEn?: string | null
    sourceUrl?: string | null
    models?: readonly string[]
  }
}

// Un ensamble es identidad: nombre, moto y de dónde salió. Sin precio, medidas ni stock — eso
// vive en sus piezas (ver el modelo Ensamble). Por eso este formulario es tan corto.
export default function EnsambleForm({ action, submitLabel, cancelHref, defaultValues: d = {} }: Props) {
  return (
    <FormConResultado action={action} className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Identificación</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre (español)</label>
            <input name="nameEs" defaultValue={d.nameEs ?? ''} placeholder="Ej: Pedal de freno trasero"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Opcional. Se usa en presupuestos; si falta, se muestra el nombre en inglés.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre (inglés) <span className="text-red-500">*</span></label>
            <input name="nameEn" required defaultValue={d.nameEn ?? ''} placeholder="Ej: Rear Brake Pedal"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Obligatorio: el nombre del catálogo Bajaj / 99rpm</p>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Moto <span className="text-red-500">*</span></label>
            <ModelPicker value={d.models ?? []} />
            <p className="text-xs text-gray-400 mt-1">
              Es lo que distingue dos ensambles con el mismo nombre. Casi siempre es una sola.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">URL fuente (99rpm)</label>
            <input name="sourceUrl" type="url" defaultValue={d.sourceUrl ?? ''} placeholder="https://..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
        </div>
      </section>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
        <Link href={cancelHref} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
          Cancelar
        </Link>
        <PendingButton
          pendingLabel="Guardando..."
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </PendingButton>
      </div>
    </FormConResultado>
  )
}
