'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { CAMPO_CARGADO, FIELD_META } from './campos'

// Todos los valores numéricos del Config se leen con parseFloat, que ignora todo
// después de una coma ("96,50" → 96) en vez de tratarla como separador decimal.
// Como acá se usa coma para decimales, normalizamos formatos "96,50" o "1.234,56"
// a notación con punto antes de guardar, para no perder silenciosamente los decimales.
function normalizeDecimalComma(value: string): string {
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(value)) return value.replace(/\./g, '').replace(',', '.')
  if (/^-?\d+,\d+$/.test(value)) return value.replace(',', '.')
  return value
}

export async function saveConfig(formData: FormData) {
  // Se toma el ÚLTIMO valor de cada key, no el primero. Un checkbox destildado no manda
  // nada, así que los campos booleanos van como un hidden con "false" seguido del
  // checkbox con "true": destildado llega solo el hidden, tildado llegan los dos y gana
  // el de atrás. Sin esta pasada, además, la misma key se escribía dos veces en la base.
  const valores = new Map<string, string>()
  let cargadoEn = 0
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') continue
    if (key === CAMPO_CARGADO) { cargadoEn = Number(value) || 0; continue }
    // Next agrega `$ACTION_ID_<hash>` (y `$ACTION_REF_…`, `$ACTION_KEY`) a todo form de
    // server action: comparar contra `'$ACTION_ID'` exacto no atrapaba ninguno y el hash
    // terminaba guardado como una clave de Config.
    if (!key || key.startsWith('$')) continue
    valores.set(key, value)
  }

  // Se escribe SOLO lo que cambió. Hacer upsert de todo en cada guardado pisaba, con el
  // valor que tenía el formulario al abrirse, lo que el cron hubiera escrito mientras
  // tanto (y le refrescaba el `updatedAt` a las tasas, que es justo lo que se mira para
  // notar un cron caído). Es también por lo que tardaba segundos: ~28 upserts en serie.
  const filas = await db.config.findMany({ select: { key: true, value: true, updatedAt: true } })
  const actuales = new Map(filas.map(f => [f.key, f]))

  const escrituras = []
  const delCron: string[] = []
  for (const [key, value] of valores) {
    const actual = actuales.get(key)
    // Solo claves que el código conoce o que ya existen: un POST armado a mano no
    // inventa configuración.
    if (!actual && !FIELD_META[key]) continue

    const normalized = normalizeDecimalComma(value.trim())
    if (normalized === (actual?.value ?? '')) continue

    // El cron escribió esta tasa DESPUÉS de que se abrió el formulario: lo que trae el
    // campo es el valor viejo, y guardarlo desharía la actualización. Se respeta la del
    // cron y se avisa; para fijar una tasa a mano hay que reabrir la pantalla.
    if (FIELD_META[key]?.cron && actual && cargadoEn > 0 && actual.updatedAt.getTime() > cargadoEn) {
      delCron.push(key)
      continue
    }

    escrituras.push(
      db.config.upsert({
        where: { key },
        update: { value: normalized },
        create: { key, value: normalized },
      }),
    )
  }

  if (escrituras.length > 0) await db.$transaction(escrituras)

  // Las tarifas del Config entran en el landed de cada pieza, así que un cambio acá
  // repercute en catálogo, ensambles, presupuestos y envíos por igual.
  revalidatePath('/', 'layout')

  const params = new URLSearchParams({ saved: escrituras.length > 0 ? '1' : '0' })
  if (delCron.length > 0) params.set('cron', delCron.join(','))
  redirect(`/config?${params}`)
}
