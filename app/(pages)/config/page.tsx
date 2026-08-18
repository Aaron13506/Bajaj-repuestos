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
  // ── Escenario marítimo directo (India → Venezuela por mar, sin aéreo ni escala en USA).
  // Solo lo usa el simulador (/simular, modo Marítimo). No afecta ningún costo actual.
  maritimo_directo_per_ft3: { label: 'Marítimo directo India → VEN (USD/ft³)', hint: 'Flete completo por mar, por pie cúbico. Reemplaza al aéreo + Miami→CCS. Vacío = usa la tarifa Miami→CCS como respaldo' },
  maritimo_min_ft3:         { label: 'Mínimo facturable marítimo (ft³)',       hint: 'Piso de volumen que cobra la naviera por embarque. 0 = cobra el volumen real, sin mínimo' },
  maritimo_fee_usd:         { label: 'Gastos fijos marítimo (USD)',            hint: 'Cargo fijo por caja: origen, destino, handling, aduana. 0 si ya están dentro del USD/ft³' },
  maritimo_insurance_pct:   { label: 'Seguro marítimo (fracción)',             hint: '% sobre el costo de producto. Vacío = 0.06 (6%), la prima por mar' },
  // ── Modo Marítimo CBM (India → Venezuela por mar, cotización real por m³).
  // Solo tienen efecto con el modo CBM activo (se alterna en el sidebar).
  cbm_rate_usd:           { label: 'Tarifa marítima (USD por m³)',   hint: 'Tarifa plana India → Venezuela por metro cúbico. Incluye todo el trayecto: flete, seguro, origen, destino y aduana' },
  cbm_fob_india_usd:      { label: 'FOB India (USD por embarque)',   hint: 'Monto FIJO por embarque, no escala con el volumen. Llenar más la caja lo diluye entre más piezas y baja el landed de cada una' },
  cbm_min_m3:             { label: 'Mínimo facturable (m³)',         hint: 'Piso de volumen que cobra la naviera por embarque aunque mandes menos. Vacío = 1 m³ (típico LCL)' },
  cbm_referencia_m3:      { label: 'Embarque de referencia (m³)',    hint: 'Volumen supuesto para prorratear el FOB al costear una pieza suelta en el catálogo. Vacío = 1 m³. Subilo si consolidás embarques más grandes: baja el landed de todo el catálogo' },
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

  // Keys que el usuario agregó a mano y no están en FIELD_META. `app_modo` quedó de
  // cuando existía un modo global de la app; si sobrevive alguna fila, se oculta: la ruta
  // hoy la define cada envío, no una preferencia global.
  const extraKeys = Object.keys(configMap).filter(k => !FIELD_META[k] && k !== 'app_modo')

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
