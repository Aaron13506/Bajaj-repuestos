import { db } from '@/lib/db'
import { saveConfig } from './actions'
import { TERMINOS_DEFAULTS } from '@/lib/terminos'
import { toConfigMap, flag } from '@/lib/config'
import { resolveRateTable } from '@/lib/shipping-rates'
import { haceTiempo } from '@/lib/utils'
import PendingButton from '@/components/PendingButton'
import { CAMPO_CARGADO, FIELD_META } from './campos'

const DEFAULT_KEYS = Object.keys(FIELD_META)

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; cron?: string }>
}) {
  const { saved, cron } = await searchParams
  const rows = await db.config.findMany({ orderBy: { key: 'asc' } })

  // Merge DB values with defaults so all known keys always appear
  const configMap: Record<string, { value: string; description: string | null; updatedAt: Date | null }> = {}
  for (const row of rows) {
    configMap[row.key] = { value: row.value, description: row.description, updatedAt: row.updatedAt }
  }

  // Ensure all meta keys are present even if not yet in DB
  for (const key of DEFAULT_KEYS) {
    if (!configMap[key]) configMap[key] = { value: '', description: null, updatedAt: null }
  }

  // Keys que el usuario agregó a mano y no están en FIELD_META.
  const extraKeys = Object.keys(configMap).filter(k => !FIELD_META[k])

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
      {saved === '0' && (
        <div className="mb-6 bg-gray-50 border border-gray-200 text-gray-700 rounded-lg px-4 py-3 text-sm font-medium">
          No había nada que guardar: ningún valor cambió.
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
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
          {allKeys.map(key => {
            const meta    = FIELD_META[key]
            const stored  = configMap[key]
            const options = optionsFor(key)
            return (
              <div key={key} className="px-6 py-4">
                <label className="block mb-1">
                  <span className="text-sm font-medium text-gray-800">
                    {meta?.label ?? key}
                  </span>
                  <span className="ml-2 font-mono text-xs text-gray-400">{key}</span>
                </label>
                {/* La ayuda del código gana sobre la `description` de la fila: esa la
                    escribió el seed y queda vieja (la de shoppre_member todavía pedía
                    escribir "true"). La de la base solo se muestra para las keys que el
                    código no conoce, que son las únicas que no tienen ayuda acá. */}
                {(meta?.hint || stored.description) && (
                  <p className="text-xs text-gray-500 mb-2">{meta?.hint ?? stored.description}</p>
                )}
                {meta?.cron && (
                  <p className="text-xs text-gray-400 mb-2">
                    {stored.updatedAt
                      ? `Actualizado ${haceTiempo(stored.updatedAt)} — cron horario (pnpm fx:update)`
                      : 'Todavía no lo actualizó el cron'}
                  </p>
                )}
                {meta?.boolean ? (
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
                    <span>Aplicar la tarifa de socio</span>
                  </label>
                ) : meta?.multiline ? (
                  <textarea
                    name={key}
                    rows={8}
                    defaultValue={stored.value || TERMINOS_DEFAULTS[key] || ''}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                ) : options ? (
                  <select
                    name={key}
                    defaultValue={stored.value || options[0]}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
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
          <PendingButton className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            Guardar cambios
          </PendingButton>
        </div>
      </form>
    </div>
  )
}
