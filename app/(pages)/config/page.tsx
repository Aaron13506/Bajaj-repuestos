import { db } from '@/lib/db'
import { saveConfig } from './actions'
import { TERMINOS_DEFAULTS } from '@/lib/terminos'
import { toConfigMap, flag } from '@/lib/config'
import { resolveRateTable } from '@/lib/shipping-rates'
import { haceTiempo } from '@/lib/utils'
import PendingButton from '@/components/PendingButton'
import { CAMPO_CARGADO, FIELD_META } from './campos'

// Secciones de la pantalla. Una key de FIELD_META que nadie ubicó acá cae en "Otros", no desaparece.
const GRUPOS: { titulo: string; keys: string[]; ancho?: boolean }[] = [
  { titulo: 'Tasas de cambio', keys: ['inr_usd_rate', 'bsd_usd_rate', 'bcv_usd_rate', 'bcv_brecha_pct'] },
  { titulo: 'Ventas y presupuestos', keys: ['default_margin_pct', 'presupuesto_validez_dias', 'reclamo_horas'] },
  { titulo: 'Flete aéreo (Shoppre → Miami → CCS)', keys: ['shoppre_member', 'shoppre_carrier', 'shoppre_insurance_pct', 'shoppre_processing_inr', 'reference_weight_kg', 'air_volumetric_divisor', 'caja_sin_pesar_tolerancia_pct', 'miami_caracas_per_ft3'] },
  { titulo: 'Marítimo CBM (stock propio)', keys: ['cbm_rate_usd', 'cbm_fob_india_usd', 'cbm_min_m3', 'cbm_referencia_m3', 'ensambles_columnas_maritimas'] },
  { titulo: 'Marítimo directo (solo /simular)', keys: ['maritimo_directo_per_ft3', 'maritimo_min_ft3', 'maritimo_fee_usd', 'maritimo_insurance_pct'] },
  { titulo: 'Términos y condiciones', keys: ['terminos_presupuesto', 'terminos_pedido'], ancho: true },
]
const ubicadas = new Set(GRUPOS.flatMap(g => g.keys))
const sueltas = Object.keys(FIELD_META).filter(k => !ubicadas.has(k))
if (sueltas.length > 0) GRUPOS.push({ titulo: 'Otros', keys: sueltas })

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; cron?: string; invalido?: string }>
}) {
  const { saved, cron, invalido } = await searchParams
  const rows = await db.config.findMany({ orderBy: { key: 'asc' } })

  // Solo se editan las keys que el código conoce. Las demás filas tienen dueño en otra parte
  // (caja_apertura_* en /contabilidad, shoppre_rates_usd el cron) o ya nadie las lee, y como
  // texto libre invitaban a romperlas.
  const guardado = new Map(rows.map(r => [r.key, r]))

  // Cuándo escribió el cron por última vez, tal como estaba la base al abrir esta pantalla.
  // `saveConfig` lo compara contra el `updatedAt` actual para no pisar una tasa que el
  // cron actualizó mientras el formulario estaba abierto.
  const cargado = Math.max(
    0,
    ...rows.filter(r => FIELD_META[r.key]?.cron).map(r => r.updatedAt.getTime()),
  )

  const cfg = toConfigMap(rows)

  // El transportista es una lista cerrada, y las opciones salen de la tabla de tarifas
  // vigente: el nombre tiene que coincidir EXACTO con su clave, porque uno que no está
  // cae en silencio al Duty Free (ver `pasosDe` en lib/shipping-rates.ts) y se costea con
  // otra tarifa sin que nada lo diga. Escrito a mano, un espacio de más bastaba.
  // Se resuelve por request y no se guarda en FIELD_META, que es un módulo compartido.
  const optionsFor = (key: string): string[] | undefined =>
    key === 'shoppre_carrier'
      ? Object.keys(resolveRateTable(cfg).carriers)
      : FIELD_META[key]?.options

  const campo = (key: string) => {
    const meta    = FIELD_META[key]
    const stored  = guardado.get(key)
    const options = optionsFor(key)
    return (
      <div key={key}>
        <label className="block mb-1">
          <span className="text-sm font-medium text-gray-800">
            {meta.label}
          </span>
          <span className="ml-2 font-mono text-xs text-gray-400">{key}</span>
        </label>
        {/* La ayuda es la del código, no la `description` de la fila: esa la escribió el
            seed y quedó vieja (la de shoppre_member todavía pedía escribir "true"). */}
        <p className="text-xs text-gray-500 mb-2">{meta.hint}</p>
        {meta.cron && (
          <p className="text-xs text-gray-400 mb-2">
            {stored?.updatedAt
              ? `Actualizado ${haceTiempo(stored.updatedAt)} — cron horario (pnpm fx:update)`
              : 'Todavía no lo actualizó el cron'}
          </p>
        )}
        {meta.boolean ? (
          <label className="flex items-center gap-2 text-sm text-gray-800">
            {/* Destildado el checkbox no manda nada: el hidden es el que guarda el
                "false". saveConfig se queda con el último valor de la key. */}
            <input type="hidden" name={key} value="false" />
            <input
              type="checkbox"
              name={key}
              value="true"
              defaultChecked={flag(cfg, key, meta.booleanDefault ?? false)}
              className="accent-blue-600 h-4 w-4"
            />
            {/* Texto fijo: esto es un Server Component, así que no puede seguir
                al check. Lo que vale es el estado del cuadrito. */}
            <span>{meta.checkLabel ?? 'Activado'}</span>
          </label>
        ) : meta.multiline ? (
          <textarea
            name={key}
            rows={8}
            defaultValue={stored?.value || TERMINOS_DEFAULTS[key] || ''}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        ) : options ? (
          <select
            name={key}
            defaultValue={stored?.value || options[0]}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type="text"
            inputMode={meta.rango ? 'decimal' : undefined}
            name={key}
            defaultValue={stored?.value}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        )}
      </div>
    )
  }

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Configuración</h1>
      </div>

      {saved === '1' && (
        <div className="mb-6 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm font-medium">
          Cambios guardados correctamente.
        </div>
      )}
      {saved === '0' && (
        <div className="mb-6 bg-gray-50 border border-gray-200 text-gray-700 rounded-lg px-4 py-3 text-sm font-medium">
          No había nada que guardar: ningún valor cambió.
        </div>
      )}
      {invalido && (
        <div role="alert" className="mb-6 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">
          No se guardó nada: {invalido.split(',').map(k => {
            const m = FIELD_META[k]
            return m?.rango ? `${m.label} (entre ${m.rango[0]} y ${m.rango[1] === Infinity ? '∞' : m.rango[1]})` : k
          }).join(' · ')} {invalido.split(',').length === 1 ? 'está' : 'están'} fuera de rango. Los seguros van en
          fracción (0.03 = 3%).
        </div>
      )}
      {cron && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">
          El cron actualizó <span className="font-mono">{cron.split(',').join(', ')}</span> mientras
          tenías esta pantalla abierta, así que no se pisó con el valor viejo. Si querés fijarla a
          mano, volvé a escribirla ahora.
        </div>
      )}

      <form action={saveConfig}>
        <input type="hidden" name={CAMPO_CARGADO} value={cargado} />
        <div className="grid gap-6 lg:grid-cols-2 items-start">
          {GRUPOS.map(g => (
            <section
              key={g.titulo}
              className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 ${g.ancho ? 'lg:col-span-2' : ''}`}
            >
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">{g.titulo}</h2>
              <div className={`grid gap-5 ${g.ancho ? 'lg:grid-cols-2' : ''}`}>
                {g.keys.map(campo)}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-6 flex justify-end">
          <PendingButton className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            Guardar cambios
          </PendingButton>
        </div>
      </form>
    </div>
  )
}
