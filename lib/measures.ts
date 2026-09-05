import { db } from './db'
import type { Prisma } from '@prisma/client'
import { reprice } from './reprice'
import { chequearMedidas, hayError } from './measures-check'
import { extractJson } from './json-ia'
import { getConfig } from './config-db'
import { margenPorDefecto } from './config'
import { msg, toInt, toNum, toStr } from './parse'

// Se re-exporta porque era parte de la API de este módulo antes de mudarse a lib/json-ia.
export { extractJson }

// ─────────────────────────────────────────────────────────────────────────────
// Carga de peso y dimensiones desde una respuesta de IA.
//
// Vive en lib (y no en un server action) porque el mismo flujo se usa desde tres
// lugares distintos — la ficha de un ensamble, un presupuesto y un envío — y todos
// necesitan exactamente el mismo parseo tolerante y el mismo recálculo de precio.
// Cada llamador solo aporta qué rutas revalidar.
//
// Peso y dimensiones se cargan SIEMPRE juntos: una pieza a la que le falta el peso le
// falta también el volumen, y en modo CBM el volumen es lo único que se factura.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasuresResult {
  ok: boolean
  updated: number       // filas de Product actualizadas
  priced: number        // de esas, cuántas quedaron con precio recalculado (> 0)
  rejected: number      // filas que NO se escribieron por no pasar el chequeo físico
  notFound: string[]    // identificadores que no matchearon ningún producto
  errors: { name: string; message: string }[]
  // Se escribieron igual, pero hay algo raro. Van aparte de `errors` porque exigen
  // mirarlas, no corregirlas: un plástico hueco grande dispara el aviso y está bien.
  warnings: { name: string; message: string }[]
  message?: string
}

export const emptyMeasuresResult: MeasuresResult = {
  ok: false, updated: 0, priced: 0, rejected: 0, notFound: [], errors: [], warnings: [],
}

// JSON laxo: la IA puede devolver strings o números. Cada fila identifica un
// producto existente (por id o bajajCode) y trae SOLO los campos físicos a cargar.
interface RawMeasure {
  id?: unknown
  bajajCode?: unknown
  sku?: unknown             // alias tolerado de bajajCode
  code?: unknown            // alias tolerado de bajajCode
  weightGrams?: unknown
  weight?: unknown          // alias tolerado (gramos)
  dimL?: unknown
  dimA?: unknown
  dimH?: unknown
}

// Normaliza la entrada a un array de filas, tolerando {items:[...]}, un objeto suelto,
// o un array directo.
function collectRows(parsed: unknown): RawMeasure[] {
  if (Array.isArray(parsed)) return parsed as RawMeasure[]
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.items)) return o.items as RawMeasure[]
    if (Array.isArray(o.products)) return o.products as RawMeasure[]
    if (Array.isArray(o.measures)) return o.measures as RawMeasure[]
    return [parsed as RawMeasure]
  }
  return []
}

// Aplica las medidas de la respuesta de la IA sobre el catálogo y recalcula el precio.
// No revalida rutas: eso lo hace el server action que la llama, que es el que sabe desde
// qué pantalla se cargó.
export async function applyMeasures(raw: string): Promise<MeasuresResult> {
  const text = raw.trim()
  if (!text) return { ...emptyMeasuresResult, message: 'Pegá el JSON primero.' }

  let parsed: unknown
  try {
    // La respuesta puede traer razonamiento/fuentes: extraemos el JSON embebido.
    parsed = JSON.parse(extractJson(text))
  } catch (e) {
    return { ...emptyMeasuresResult, message: `JSON inválido: ${msg(e)}` }
  }

  const rows = collectRows(parsed)
  if (rows.length === 0) {
    return { ...emptyMeasuresResult, message: 'El JSON no contenía filas.' }
  }

  const cfg = await getConfig()
  const defaultMargin = margenPorDefecto(cfg)

  let updated = 0
  let priced = 0
  let rejected = 0
  const notFound: string[] = []
  const errors: MeasuresResult['errors'] = []
  const warnings: MeasuresResult['warnings'] = []

  // ── 1. Parseo de todas las filas (puro, sin tocar la base) ─────────────────
  interface FilaLista {
    label: string
    idNum: number | null
    code: string | null
    patch: { weightGrams?: number | null; dimL?: number | null; dimA?: number | null; dimH?: number | null }
  }
  const listas: FilaLista[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const idNum = toInt(r.id)
    const code = toStr(r.bajajCode) ?? toStr(r.sku) ?? toStr(r.code)
    const label = idNum != null ? `id ${idNum}` : code ?? `(fila #${i + 1})`

    // Solo los campos presentes se actualizan; los omitidos conservan su valor.
    const patch: FilaLista['patch'] = {}
    if ('weightGrams' in r || 'weight' in r) patch.weightGrams = toInt(r.weightGrams ?? r.weight)
    if ('dimL' in r) patch.dimL = toNum(r.dimL)
    if ('dimA' in r) patch.dimA = toNum(r.dimA)
    if ('dimH' in r) patch.dimH = toNum(r.dimH)

    if (Object.keys(patch).length === 0) {
      errors.push({ name: label, message: 'Sin campos de peso/dimensiones para actualizar.' })
      continue
    }
    if (idNum == null && !code) {
      errors.push({ name: label, message: 'Falta identificador (id o bajajCode).' })
      continue
    }
    listas.push({ label, idNum, code, patch })
  }

  // ── 2. UNA consulta para todos los objetivos ───────────────────────────────
  // Antes esto era un findMany por fila y después un update por producto, todo
  // encadenado: un ensamble de 30 piezas eran ~60 idas y vueltas al pooler en us-west-2,
  // en serie. Lo que manda en el tiempo de esta pantalla no es lo que tarda Postgres,
  // es cuántas veces se cruza la red.
  const ids = listas.map(f => f.idNum).filter((v): v is number => v != null)
  const codes = listas.map(f => f.code).filter((v): v is string => v != null)
  const encontrados = await db.product.findMany({
    where: {
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(codes.length ? [{ bajajCode: { in: codes } }] : []),
      ],
    },
  })

  type Fila = (typeof encontrados)[number]
  const porId = new Map<number, Fila>(encontrados.map(p => [p.id, p]))
  // Un bajajCode puede repetirse en varios productos (mismo SKU reusado), así que el
  // índice por código es uno a muchos — igual que el findMany que reemplaza.
  const porCode = new Map<string, Fila[]>()
  for (const p of encontrados) {
    if (!p.bajajCode) continue
    const ya = porCode.get(p.bajajCode)
    if (ya) ya.push(p)
    else porCode.set(p.bajajCode, [p])
  }

  // ── 3. Fusión, chequeo y armado de los updates ─────────────────────────────
  // `estado` es la copia de trabajo: si dos filas apuntan al mismo producto (una por id y
  // otra por bajajCode), la segunda se fusiona sobre el resultado de la primera y no sobre
  // la fila original. Es lo que hacía la versión secuencial al releer la base, y hay que
  // conservarlo o el último patch pisaría los campos del anterior.
  const estado = new Map<number, Fila>(encontrados.map(p => [p.id, { ...p }]))
  const ops: Prisma.PrismaPromise<unknown>[] = []

  for (const f of listas) {
    const targets = f.idNum != null
      ? (porId.has(f.idNum) ? [porId.get(f.idNum)!] : [])
      : (porCode.get(f.code!) ?? [])

    if (targets.length === 0) {
      notFound.push(f.label)
      continue
    }

    for (const base of targets) {
      const p = estado.get(base.id)!
      const merged = {
        priceInr:    p.priceInr,
        weightGrams: f.patch.weightGrams !== undefined ? f.patch.weightGrams : p.weightGrams,
        dimL:        f.patch.dimL !== undefined ? f.patch.dimL : p.dimL,
        dimA:        f.patch.dimA !== undefined ? f.patch.dimA : p.dimA,
        dimH:        f.patch.dimH !== undefined ? f.patch.dimH : p.dimH,
      }

      // Chequeo físico ANTES de escribir, sobre el resultado FUSIONADO: una fila que
      // solo trae peso hay que juzgarla contra las dimensiones que ya estaban, porque
      // es esa combinación la que va a costear. Lo imposible no entra — el catálogo es
      // la fuente del precio de venta, y un dato absurdo ahí se cobra en flete.
      const chequeos = chequearMedidas(merged)
      const etiqueta = `${p.bajajCode ?? f.label} · ${p.nameEs}`
      if (hayError(chequeos)) {
        rejected++
        for (const c of chequeos.filter(c => c.severidad === 'error')) {
          errors.push({ name: etiqueta, message: `${c.mensaje} NO se guardó.` })
        }
        continue
      }
      for (const c of chequeos) warnings.push({ name: etiqueta, message: c.mensaje })

      // El recálculo de precio vive en lib/reprice.ts: es la misma cuenta que corre
      // cuando cambia el ₹ de 99rpm, y una segunda copia daría dos catálogos que se
      // contradicen. Acá solo se aportan las medidas nuevas.
      const rp = reprice(
        { ...merged, margin: p.margin, price: Number(p.price), priceLocked: p.priceLocked },
        cfg,
        defaultMargin,
      )
      if (rp.repriced) priced++

      // La copia de trabajo avanza para la próxima fila que toque este mismo producto.
      Object.assign(p, merged, rp.data)

      ops.push(db.product.update({ where: { id: p.id }, data: { ...merged, ...rp.data } }))
      updated++
    }
  }

  // ── 4. Un solo viaje para escribir ─────────────────────────────────────────
  // Las filas que no pasaron el chequeo físico ya quedaron afuera, así que lo que entra
  // acá está validado: un fallo a esta altura es de la base y afecta a todo por igual.
  // Que sea atómico evita el estado a medias que dejaba el bucle si se cortaba la red.
  if (ops.length > 0) {
    try {
      await db.$transaction(ops)
    } catch (e) {
      return {
        ...emptyMeasuresResult,
        rejected,
        notFound,
        errors: [...errors, { name: 'Escritura', message: msg(e) }],
        warnings,
        message: `No se guardó nada: falló la escritura (${msg(e)}).`,
      }
    }
  }

  const parts: string[] = []
  parts.push(`${updated} producto(s) actualizado(s)`)
  if (priced > 0) parts.push(`${priced} con precio recalculado`)
  if (rejected > 0) parts.push(`${rejected} RECHAZADO(S) por chequeo físico`)
  if (notFound.length > 0) parts.push(`${notFound.length} no encontrado(s)`)
  if (warnings.length > 0) parts.push(`${warnings.length} con aviso`)
  if (errors.length > 0) parts.push(`${errors.length} con error`)

  return {
    ok: errors.length === 0 && notFound.length === 0,
    updated,
    priced,
    rejected,
    notFound,
    errors,
    warnings,
    message: parts.join(', ') + '.',
  }
}