import { db } from '@/lib/db'
import { saveConfig } from './actions'
import { TERMINOS_DEFAULTS } from '@/lib/terminos'

const FIELD_META: Record<string, { label: string; hint: string; type?: string; multiline?: boolean }> = {
  inr_usd_rate:           { label: 'Tasa INR / USD',               hint: 'Rupias indias por 1 USD — ver XE.com' },
  bsd_usd_rate:           { label: 'Tasa BsD / USD',               hint: 'Bolívares por 1 USD (BCV o paralelo)' },
  shoppre_member:         { label: 'Membresía Shoppre',            hint: '"true" para usar tarifa con descuento, "false" para tarifa normal' },
  shoppre_carrier:        { label: 'Transportista Shoppre',        hint: '"ShipGlobal USA - Duty Free" o "Economy Shipping"' },
  reference_weight_kg:    { label: 'Peso de referencia (kg)',      hint: 'Peso total del envío de referencia para prorratear costos Shoppre' },
  air_volumetric_divisor: { label: 'Divisor volumétrico aéreo',     hint: 'vol_kg = L×A×H(cm) / divisor. Shoppre/ShipGlobal: 5000 (IATA clásico: 6000)' },
  miami_caracas_per_ft3:  { label: 'Marítimo Miami → CCS (USD/ft³)', hint: 'Costo del flete marítimo por pie cúbico' },
  shoppre_insurance_pct:  { label: 'Seguro Shoppre (fracción)',    hint: 'P.ej. 0.03 = 3% sobre el valor declarado' },
  shoppre_processing_inr: { label: 'Processing fee Shoppre (INR)', hint: 'Cargo fijo por paquete en rupias' },
  default_margin_pct:     { label: 'Margen por defecto (%)',       hint: 'Margen de ganancia al crear un producto; luego se ajusta por producto' },
  terminos_presupuesto:   { label: 'Términos y condiciones — Presupuesto', hint: 'Texto que aparece al pie del presupuesto al imprimir / guardar como PDF', multiline: true },
  terminos_pedido:        { label: 'Términos y condiciones — Pedido oficial', hint: 'Texto que aparece al pie del pedido confirmado al imprimir / guardar como PDF', multiline: true },
}

const DEFAULT_KEYS = Object.keys(FIELD_META)

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>
}) {
  const { saved } = await searchParams
  const rows = await db.config.findMany({ orderBy: { key: 'asc' } })

  // Merge DB values with defaults so all known keys always appear
  const configMap: Record<string, { value: string; description: string | null }> = {}
  for (const row of rows) {
    configMap[row.key] = { value: row.value, description: row.description }
  }

  // Ensure all meta keys are present even if not yet in DB
  for (const key of DEFAULT_KEYS) {
    if (!configMap[key]) configMap[key] = { value: '', description: null }
  }

  // Custom keys not in FIELD_META (user may have added extra)
  const extraKeys = Object.keys(configMap).filter(k => !FIELD_META[k])

  const allKeys = [...DEFAULT_KEYS, ...extraKeys]

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Configuración</h1>
      </div>

      {saved === '1' && (
        <div className="mb-6 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm font-medium">
          Cambios guardados correctamente.
        </div>
      )}

      <form action={saveConfig}>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
          {allKeys.map(key => {
            const meta   = FIELD_META[key]
            const stored = configMap[key]
            return (
              <div key={key} className="px-6 py-4">
                <label className="block mb-1">
                  <span className="text-sm font-medium text-gray-800">
                    {meta?.label ?? key}
                  </span>
                  <span className="ml-2 font-mono text-xs text-gray-400">{key}</span>
                </label>
                {stored.description && (
                  <p className="text-xs text-gray-500 mb-2">{stored.description}</p>
                )}
                {meta?.hint && !stored.description && (
                  <p className="text-xs text-gray-500 mb-2">{meta.hint}</p>
                )}
                {meta?.multiline ? (
                  <textarea
                    name={key}
                    rows={8}
                    defaultValue={stored.value || TERMINOS_DEFAULTS[key] || ''}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                ) : (
                  <input
                    type="text"
                    name={key}
                    defaultValue={stored.value}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Guardar cambios
          </button>
        </div>
      </form>
    </div>
  )
}
