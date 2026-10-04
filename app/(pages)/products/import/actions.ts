'use server'

import { db } from '@/lib/db'
import { toModelIds, fullModel, parseModels } from '@/lib/modelo'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { revalidatePath } from 'next/cache'
import { getConfig } from '@/lib/config-db'
import { margenPorDefecto } from '@/lib/config'
import { msg, round2, toInt, toNum, toStr } from '@/lib/parse'
import { equivalenciasDe } from '@/lib/alt-sku'
import { chequearMedidas, hayError } from '@/lib/measures-check'

// Resultado del import que se devuelve al cliente vía useFormState.
export interface ImportResult {
  ok: boolean
  created: number
  /** Piezas que ya estaban en el catálogo (o venían repetidas en el JSON): se enlazaron en
   *  vez de crearse de nuevo. */
  linked: number
  errors: { name: string; message: string }[]
  message?: string
}

// JSON laxo: la IA puede devolver strings o números, así que normalizamos
// campo por campo. Todos los campos son opcionales salvo nameEs.
interface RawProduct {
  isAssembly?: unknown
  nameEs?: unknown
  name?: unknown            // alias tolerado
  nameEn?: unknown
  bajajCode?: unknown
  models?: unknown
  compatibleModels?: unknown   // alias tolerado: texto libre de la versión vieja
  sourceUrl?: unknown
  description?: unknown
  notes?: unknown
  priceInr?: unknown
  weightGrams?: unknown
  dimL?: unknown
  dimA?: unknown
  dimH?: unknown
  margin?: unknown          // en porcentaje, ej: 40 = 40%
  price?: unknown           // USD; si falta, se calcula desde landed + margen, o 0
  stock?: unknown
  quantity?: unknown        // cantidad del hijo dentro del ensamble
}

interface RawSubgroup {
  name?: unknown
  groupName?: unknown       // alias tolerado
  products?: unknown
}

interface RawGroup extends RawProduct {
  subgroups?: unknown
  products?: unknown        // hijos directos sin subgrupo
}

const norm = (s: string) => s.trim().toUpperCase()

// Construye el objeto que se inserta en Prisma. Lanza si falta nameEs.
//
// Peso y medidas pasan por `chequearMedidas`, el gate del catálogo (ver lib/measures-check):
// este importador escribía lo que trajera el JSON —casi siempre la respuesta de una IA— sin
// mirarlo, así que el caso del alerón de 1 g podía volver a entrar por acá. Si el juego es
// físicamente imposible NO se guarda (la pieza se crea igual, sin peso ni medidas) y se
// devuelve el motivo: costearla con un dato roto sería peor que costearla con uno faltante.
function buildProductData(it: RawProduct, cfg: ConfigMap, defaultMargin: number, forceAssembly = false) {
  const nameEs = toStr(it.nameEs) ?? toStr(it.name)
  if (!nameEs) throw new Error('Falta nameEs (nombre en español).')

  const priceInr = toInt(it.priceInr)
  const medidasJson = {
    weightGrams: toInt(it.weightGrams),
    dimL: toNum(it.dimL),
    dimA: toNum(it.dimA),
    dimH: toNum(it.dimH),
  }
  const errores = chequearMedidas(medidasJson).filter(c => c.severidad === 'error')
  const medidasRechazadas = hayError(errores) ? errores.map(c => c.mensaje).join(' ') : null
  const { weightGrams, dimL, dimA, dimH } = medidasRechazadas
    ? { weightGrams: null, dimL: null, dimA: null, dimH: null }
    : medidasJson

  const marginPct = toNum(it.margin)
  const margin = marginPct != null ? marginPct / 100 : defaultMargin

  const breakdown = calcLanded({ priceInr, weightGrams, dimL, dimA, dimH, margin }, cfg)
  const landedCostUsd = breakdown ? round2(breakdown.landedCostUsd) : null

  // Precio: el explícito gana; si no, el calculado; si tampoco, 0 (se completa luego).
  const explicitPrice = toNum(it.price)
  const price = explicitPrice ?? (breakdown?.priceUsd != null ? round2(breakdown.priceUsd) : 0)

  const data = {
    isAssembly:       forceAssembly || it.isAssembly === true || it.isAssembly === 'true',
    nameEs,
    nameEn:           toStr(it.nameEn),
    bajajCode:        toStr(it.bajajCode),
    compatibleModels: toModelIds(it.models ?? it.compatibleModels).map(fullModel).join(', ') || null,
    sourceUrl:        toStr(it.sourceUrl),
    description:      toStr(it.description),
    notes:            toStr(it.notes),
    priceInr,
    weightGrams,
    dimL,
    dimA,
    dimH,
    margin:           breakdown || marginPct != null ? margin : null,
    landedCostUsd,
    price,
    stock:            toInt(it.stock) ?? 0,
  }
  return { data, medidasRechazadas }
}

// Detecta si el JSON describe ensambles (grupos) o productos sueltos.
function collectGroups(parsed: unknown): RawGroup[] | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>
    if (o.group) return [o.group as RawGroup]
    if (Array.isArray(o.groups)) return o.groups as RawGroup[]
    if (Array.isArray(o.subgroups) || o.isAssembly === true || o.isAssembly === 'true') {
      return [o as RawGroup]
    }
    return null
  }
  if (Array.isArray(parsed) && parsed.some(e => e && typeof e === 'object' && Array.isArray((e as RawGroup).subgroups))) {
    return parsed as RawGroup[]
  }
  return null
}

// Los subgrupos de un ensamble: explícitos, o los hijos directos bajo un subgrupo vacío.
function subgruposDe(g: RawGroup): RawSubgroup[] {
  return Array.isArray(g.subgroups)
    ? (g.subgroups as RawSubgroup[])
    : Array.isArray(g.products)
      ? [{ name: '', products: g.products }]
      : []
}

// Las etiquetas de motos como clave comparable: sin importar el orden en que se listaron.
const clavePorMotos = (compatibleModels: string | null) =>
  parseModels(compatibleModels).sort().join(';')

export async function importProducts(
  _prev: ImportResult,
  formData: FormData,
): Promise<ImportResult> {
  const raw = (formData.get('json') as string)?.trim() ?? ''
  if (!raw) return { ok: false, created: 0, linked: 0, errors: [], message: 'Pegá el JSON primero.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, created: 0, linked: 0, errors: [], message: `JSON inválido: ${msg(e)}` }
  }

  const cfg = await getConfig()
  const defaultMargin = margenPorDefecto(cfg)

  const errors: ImportResult['errors'] = []
  let created = 0
  let linked = 0

  const groups = collectGroups(parsed)

  // ── Qué de esto ya existe ──────────────────────────────────────────────────────────
  //
  // Este importador siempre hacía `product.create`. Importar un ensamble cuyas piezas ya
  // estaban en el catálogo las duplicaba, que es lo contrario del modelo: una pieza es UNA
  // fila con todas las motos que la usan (la compatibilidad cruzada), no una por ensamble.
  // Y reimportar el mismo JSON creaba todo otra vez.
  //
  // Una pieza se reconoce por su código, cruzando el alterno (lib/alt-sku.ts: cada fuente
  // usa uno de los dos números de Bajaj y el catálogo guarda el otro). Un ensamble no tiene
  // código confiable: su identidad es nombre + moto, que es justo lo que lo distingue de otro
  // homónimo de otra moto. Todo se busca ANTES, en dos consultas, y no pieza por pieza.
  const piezasDelJson: RawProduct[] = groups
    ? groups.flatMap(g => subgruposDe(g).flatMap(sg => (Array.isArray(sg.products) ? (sg.products as RawProduct[]) : [])))
    : (Array.isArray(parsed) ? parsed : [parsed]) as RawProduct[]

  const codigosJson = piezasDelJson
    .map(p => (p && typeof p === 'object' ? toStr(p.bajajCode) : null))
    .filter((c): c is string => c != null)
  const equivalentes = await equivalenciasDe(codigosJson)
  const codigosBuscados = [...new Set([...equivalentes.values()].flat())]

  interface Existente { id: number; compatibleModels: string | null }
  const piezasExistentes = new Map<string, Existente>()
  if (codigosBuscados.length > 0) {
    const filas = await db.$queryRaw<{ id: number; code: string; compatibleModels: string | null }[]>`
      SELECT "id", UPPER(TRIM("bajajCode")) AS code, "compatibleModels"
      FROM "Product"
      WHERE "isAssembly" = false AND "bajajCode" IS NOT NULL
        AND UPPER(TRIM("bajajCode")) = ANY(${codigosBuscados})`
    for (const f of filas) if (!piezasExistentes.has(f.code)) piezasExistentes.set(f.code, f)
  }

  const nombresEnsambles = groups
    ? [...new Set(groups.map(g => (toStr(g.nameEs) ?? toStr(g.name))?.toLowerCase()).filter((n): n is string => !!n))]
    : []
  // nombre|motos → id. Solo cuenta si el ensamble trae motos: dos "Spark Plugs" sin moto no
  // son el mismo ensamble, son dos a los que les falta el dato.
  const ensamblesExistentes = new Map<string, number>()
  if (nombresEnsambles.length > 0) {
    const filas = await db.$queryRaw<{ id: number; name: string; compatibleModels: string | null }[]>`
      SELECT "id", LOWER(TRIM("nameEs")) AS name, "compatibleModels"
      FROM "Product"
      WHERE "isAssembly" = true AND "compatibleModels" IS NOT NULL
        AND LOWER(TRIM("nameEs")) = ANY(${nombresEnsambles})`
    for (const f of filas) {
      const k = `${f.name}|${clavePorMotos(f.compatibleModels)}`
      if (!ensamblesExistentes.has(k)) ensamblesExistentes.set(k, f.id)
    }
  }

  // Las motos que hay que SUMAR al texto de compatibilidad de una pieza que ya existía (o que
  // se repite en el JSON bajo otra moto). Se juntan acá y se escriben una vez por pieza al
  // final: las piezas se procesan en paralelo, y un "leer, unir, escribir" por cada aparición
  // se pisaría entre sí.
  const motosActuales = new Map<number, string | null>()
  const motosASumar = new Map<number, Set<string>>()
  function sumarMotos(id: number, nuevas: string | null, actuales?: string | null) {
    if (actuales !== undefined && !motosActuales.has(id)) motosActuales.set(id, actuales)
    if (!nuevas) return
    const set = motosASumar.get(id) ?? new Set<string>()
    for (const label of parseModels(nuevas)) set.add(label)
    motosASumar.set(id, set)
  }

  // Crea una pieza o ensamble NUEVO y devuelve su id (o null si falló).
  async function crearNuevo(
    data: ReturnType<typeof buildProductData>['data'],
    label: string,
    medidasRechazadas: string | null,
  ): Promise<number | null> {
    try {
      const p = await db.product.create({ data })
      created++
      motosActuales.set(p.id, data.compatibleModels)
      if (medidasRechazadas) {
        errors.push({ name: label, message: `Se creó SIN peso ni medidas: ${medidasRechazadas}` })
      }
      return p.id
    } catch (e) {
      errors.push({ name: label, message: msg(e) })
      return null
    }
  }

  // Una pieza con el mismo código (o su alterno) se resuelve una sola vez aunque aparezca en
  // varios subgrupos: la segunda espera a la primera y se enlaza al mismo id.
  const enCurso = new Map<string, Promise<number | null>>()

  async function resolverPieza(
    data: ReturnType<typeof buildProductData>['data'],
    code: string,
    label: string,
    medidasRechazadas: string | null,
  ): Promise<number | null> {
    const n = norm(code)
    const equivalentesDe = equivalentes.get(n) ?? [n]
    let existente = piezasExistentes.get(n)
    if (!existente) {
      const candidatos = [...new Map(
        equivalentesDe.flatMap(c => { const e = piezasExistentes.get(c); return e ? [[e.id, e] as const] : [] }),
      ).values()]
      if (candidatos.length > 1) {
        errors.push({
          name: label,
          message: `Ambigua: sus códigos equivalentes (${equivalentesDe.join(', ')}) son piezas distintas del catálogo. No se creó ni se enlazó.`,
        })
        return null
      }
      existente = candidatos[0]
    }
    if (existente) {
      linked++
      // Lo que ya está cargado NO se pisa: el peso y las medidas costaron mucho conseguirlos y
      // el precio ya está calculado con ellos. Solo se suma la moto, que es lo único que una
      // pieza compartida gana al aparecer en otro ensamble.
      sumarMotos(existente.id, data.compatibleModels, existente.compatibleModels)
      return existente.id
    }
    return crearNuevo(data, label, medidasRechazadas)
  }

  // Crea (o reutiliza) un producto y devuelve su id (o null si falló).
  async function createOne(it: RawProduct, label: string, forceAssembly = false): Promise<number | null> {
    let built
    try {
      built = buildProductData(it, cfg, defaultMargin, forceAssembly)
    } catch (e) {
      errors.push({ name: label, message: msg(e) })
      return null
    }
    const { data, medidasRechazadas } = built

    if (data.isAssembly) {
      const clave = data.compatibleModels
        ? `${data.nameEs.trim().toLowerCase()}|${clavePorMotos(data.compatibleModels)}`
        : null
      const ya = clave ? ensamblesExistentes.get(clave) : undefined
      if (ya != null) { linked++; return ya }
      const id = await crearNuevo(data, label, medidasRechazadas)
      if (id != null && clave) ensamblesExistentes.set(clave, id)
      return id
    }

    if (!data.bajajCode) return crearNuevo(data, label, medidasRechazadas)

    // Clave canónica del par de códigos: la misma pieza tipeada con uno u otro número
    // converge en la misma entrada.
    const n = norm(data.bajajCode)
    const clave = [...(equivalentes.get(n) ?? [n])].sort()[0]
    const previa = enCurso.get(clave)
    if (previa) {
      const id = await previa
      if (id != null) { linked++; sumarMotos(id, data.compatibleModels) }
      return id
    }
    const trabajo = resolverPieza(data, data.bajajCode, label, medidasRechazadas)
    enCurso.set(clave, trabajo)
    return trabajo
  }

  // Las piezas de un subgrupo (o de una lista suelta) son independientes entre sí: nada de
  // lo que hace una cambia lo que hace la otra. Estaban encadenadas con `await` una por
  // una, y contra el pooler en us-west-2 eso son ~200 ms POR PIEZA en serie — un ensamble
  // de 50 partes tardaba lo mismo que 100 viajes seguidos. Se disparan juntas y el pool
  // (max 10) las va sirviendo.
  //
  // Se mantiene el create fila por fila, y NO un createMany, a propósito: el importador
  // reporta el error de cada pieza con su ruta (`Ensamble › Subgrupo › Pieza`), y en un
  // lote único un solo JSON mal formado tumbaría las otras 49 sin decir cuál fue.
  async function crearPiezas(
    prods: RawProduct[],
    etiqueta: (child: RawProduct, i: number) => string,
  ): Promise<(number | null)[]> {
    return Promise.all(prods.map((child, i) => createOne(child, etiqueta(child, i))))
  }

  if (groups) {
    for (const g of groups) {
      const parentName = toStr(g.nameEs) ?? toStr(g.name) ?? 'Ensamble'
      // El padre sí va antes que todo: los hijos necesitan su id para enlazarse.
      const parentId = await createOne(g, parentName, true)
      if (parentId == null) continue

      for (const sg of subgruposDe(g)) {
        const groupName = toStr(sg.name) ?? toStr(sg.groupName) ?? ''
        const prods: RawProduct[] = Array.isArray(sg.products) ? (sg.products as RawProduct[]) : []
        const ruta = (child: RawProduct) =>
          `${parentName} › ${groupName || '(sin subgrupo)'} › ${toStr(child.nameEs) ?? toStr(child.name) ?? '?'}`

        const childIds = await crearPiezas(prods, ruta)

        // sortOrder sale del índice en el JSON, no de un contador que avanza al escribir:
        // así el orden es el del documento y no el de quién terminó primero.
        const enlaces = childIds
          .map((childId, i) => ({ childId, child: prods[i], sortOrder: i }))
          .filter((e): e is { childId: number; child: RawProduct; sortOrder: number } => e.childId != null)

        await Promise.all(enlaces.map(async e => {
          try {
            await db.productComponent.create({
              data: {
                parentId,
                childId: e.childId,
                groupName,
                quantity: toInt(e.child.quantity) ?? 1,
                sortOrder: e.sortOrder,
              },
            })
          } catch (err) {
            // (padre, hijo, subgrupo) es único: si ya estaba enlazada —reimportar un ensamble
            // que ya existe— no hay nada que hacer, y tampoco es un error.
            if ((err as { code?: string }).code === 'P2002') return
            errors.push({ name: ruta(e.child), message: `Creado pero no se enlazó al ensamble: ${msg(err)}` })
          }
        }))
      }
    }
  } else {
    await crearPiezas(piezasDelJson, (it, i) => toStr(it.nameEs) ?? toStr(it.name) ?? `(item #${i + 1})`)
  }

  // Las motos nuevas de las piezas que ya existían: una escritura por pieza.
  await Promise.all([...motosASumar].map(async ([id, nuevas]) => {
    const actuales = parseModels(motosActuales.get(id))
    const faltan = [...nuevas].filter(l => !actuales.includes(l))
    if (faltan.length === 0) return
    try {
      await db.product.update({ where: { id }, data: { compatibleModels: [...actuales, ...faltan].join(', ') } })
    } catch (e) {
      errors.push({ name: `Pieza #${id}`, message: `No se pudieron sumar las motos: ${msg(e)}` })
    }
  }))

  if (created > 0 || linked > 0) {
    revalidatePath('/products')
    revalidatePath('/groups')
  }

  return {
    ok: errors.length === 0,
    created,
    linked,
    errors,
    message: created === 0 && linked === 0 && errors.length === 0
      ? 'No se creó nada (el JSON no contenía productos).'
      : `${created} producto(s) creado(s)` +
        `${linked ? `, ${linked} ya existía(n) y se enlazó(aron)` : ''}` +
        `${errors.length ? `, ${errors.length} con error` : ''}.`,
  }
}
