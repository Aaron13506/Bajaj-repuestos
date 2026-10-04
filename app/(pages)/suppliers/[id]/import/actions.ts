'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { msg, toInt, toNum, toStr } from '@/lib/parse'
import { equivalenciasDe } from '@/lib/alt-sku'

export interface SupplierImportResult {
  ok: boolean
  updated: number
  skipped: { sku: string; message: string }[]
  message?: string
}

// JSON laxo: acepta array de objetos ({sku,priceUsd} o alias) o un mapa plano
// {sku: precio}. Los valores pueden venir como string o número.
interface RawPriceEntry {
  sku?: unknown
  bajajCode?: unknown
  code?: unknown
  priceUsd?: unknown
  price?: unknown
  precio?: unknown
  moq?: unknown
  minQty?: unknown
}

interface RawEntry {
  sku: string
  priceUsd: number | null
  /** Lo que venía en el JSON, sin validar: `undefined`/`null` = el proveedor no lo declara. */
  moq: number | null
}

// Normaliza el JSON pegado a una lista plana de {sku, priceUsd, moq}, tolerando tanto un
// array de objetos como un mapa {sku: precio} (que no puede llevar MOQ).
function collectEntries(parsed: unknown): RawEntry[] {
  if (Array.isArray(parsed)) {
    return (parsed as RawPriceEntry[]).map(it => ({
      sku: toStr(it.sku) ?? toStr(it.bajajCode) ?? toStr(it.code) ?? '',
      priceUsd: toNum(it.priceUsd) ?? toNum(it.price) ?? toNum(it.precio),
      moq: toInt(it.moq ?? it.minQty),
    }))
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>).map(([sku, price]) => ({
      sku: sku.trim(),
      priceUsd: toNum(price),
      moq: null,
    }))
  }
  return []
}

// Cuántas filas viajan en cada INSERT. Un solo statement por tanda: con la base en us-west-2
// un upsert por fila eran ~200 ms CADA UNO en serie, así que 500 precios tardaban ~100 s y
// el request se moría contra el timeout de 30 s de Heroku a mitad de la carga.
const FILAS_POR_TANDA = 400

export async function importSupplierPrices(
  supplierId: number,
  _prev: SupplierImportResult,
  formData: FormData,
): Promise<SupplierImportResult> {
  const raw = (formData.get('json') as string)?.trim() ?? ''
  if (!raw) return { ok: false, updated: 0, skipped: [], message: 'Pegá el JSON primero.' }
  const isLanded = formData.get('isLanded') === 'true'

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, updated: 0, skipped: [], message: `JSON inválido: ${msg(e)}` }
  }

  const rawEntries = collectEntries(parsed)
  const skipped: SupplierImportResult['skipped'] = []
  const entries: { sku: string; priceUsd: number; moq: number | null }[] = []
  for (const e of rawEntries) {
    if (!e.sku) { skipped.push({ sku: '(sin sku)', message: 'Falta sku/bajajCode.' }); continue }
    if (e.priceUsd == null || e.priceUsd < 0) { skipped.push({ sku: e.sku, message: 'Precio (USD) inválido o faltante.' }); continue }
    // El MOQ es un piso de compra: 0 o negativo no es "sin mínimo", es un dato roto, y
    // guardarlo habilitaría pedidos de 0 piezas en el comparador.
    if (e.moq != null && e.moq < 1) { skipped.push({ sku: e.sku, message: 'MOQ inválido (tiene que ser un entero ≥ 1, o dejarlo vacío).' }); continue }
    entries.push({ sku: e.sku, priceUsd: e.priceUsd, moq: e.moq })
  }

  if (entries.length === 0) {
    return {
      ok: false,
      updated: 0,
      skipped,
      message: skipped.length ? 'Ningún ítem tenía sku y precio válidos.' : 'El JSON no contenía precios.',
    }
  }

  // Cada proveedor cotiza con UNO de los dos números que publica Bajaj (ver lib/alt-sku.ts) y
  // el catálogo guarda el otro: matchear solo por `bajajCode` exacto dejaba como "SKU no
  // encontrado" justo las piezas que sí están, y la conclusión natural era cargarlas de nuevo.
  // Se resuelve cada código a sus equivalentes y se buscan SOLO esos en el catálogo (antes se
  // traía el catálogo entero, ~5.8k filas, para usar unas pocas).
  const equivalentes = await equivalenciasDe(entries.map(e => e.sku))
  const codigos = [...new Set([...equivalentes.values()].flat())]
  const filasCatalogo = await db.$queryRaw<{ id: number; code: string }[]>`
    SELECT "id", UPPER(TRIM("bajajCode")) AS code
    FROM "Product"
    WHERE "bajajCode" IS NOT NULL AND UPPER(TRIM("bajajCode")) = ANY(${codigos})`
  const idPorCodigo = new Map<string, number>()
  for (const r of filasCatalogo) if (!idPorCodigo.has(r.code)) idPorCodigo.set(r.code, r.id)

  // productId → fila. Un mismo producto no puede ir dos veces en el mismo INSERT (Postgres se
  // niega a tocar una fila dos veces), y puede pasar de verdad: el proveedor lista las dos
  // numeraciones de una pieza. Gana la última, y se avisa.
  const porProducto = new Map<number, { sku: string; priceUsd: number; moq: number | null }>()
  for (const e of entries) {
    const tipeado = e.sku.trim().toUpperCase()
    // El código tal cual venía gana; si no está, el único equivalente que esté en el catálogo.
    let productId = idPorCodigo.get(tipeado)
    if (productId == null) {
      const candidatos = [...new Set(
        (equivalentes.get(tipeado) ?? []).map(c => idPorCodigo.get(c)).filter((id): id is number => id != null),
      )]
      if (candidatos.length > 1) {
        skipped.push({ sku: e.sku, message: 'Ambiguo: sus dos códigos equivalentes son piezas distintas del catálogo.' })
        continue
      }
      productId = candidatos[0]
    }
    if (productId == null) {
      skipped.push({ sku: e.sku, message: 'SKU no encontrado en el catálogo (ni por su código alterno).' })
      continue
    }
    const previa = porProducto.get(productId)
    if (previa) skipped.push({ sku: previa.sku, message: `Repetido: la misma pieza viene también como ${e.sku}; se usó ese precio.` })
    porProducto.set(productId, e)
  }

  const filas = [...porProducto]
  let updated = 0
  for (let i = 0; i < filas.length; i += FILAS_POR_TANDA) {
    const tanda = filas.slice(i, i + FILAS_POR_TANDA)
    const valores = Prisma.join(
      tanda.map(([productId, e]) =>
        Prisma.sql`(${productId}::int, ${supplierId}::int, ${e.priceUsd}::numeric, ${isLanded}::boolean, ${e.moq}::int, NOW())`),
    )
    try {
      // El MOQ solo se pisa si el JSON lo trae: sin él, una recarga de precios no borra el
      // mínimo que ya estaba cargado (un vacío es "no lo declara", no "se borró").
      await db.$executeRaw`
        INSERT INTO "SupplierPrice" ("productId", "supplierId", "priceUsd", "isLanded", "moq", "updatedAt")
        VALUES ${valores}
        ON CONFLICT ("productId", "supplierId") DO UPDATE
        SET "priceUsd"  = EXCLUDED."priceUsd",
            "isLanded"  = EXCLUDED."isLanded",
            "moq"       = COALESCE(EXCLUDED."moq", "SupplierPrice"."moq"),
            "updatedAt" = NOW()`
      updated += tanda.length
    } catch (err) {
      // Una fila mala tumba su tanda entera (es un solo statement): se reporta cada una.
      for (const [, e] of tanda) skipped.push({ sku: e.sku, message: `No se guardó: ${msg(err)}` })
    }
  }

  if (updated > 0) {
    revalidatePath('/products')
    revalidatePath('/envios')
    revalidatePath('/suppliers')
  }

  return {
    ok: skipped.length === 0,
    updated,
    skipped,
    message: `${updated} precio(s) cargado(s)${skipped.length ? `, ${skipped.length} omitido(s)` : ''}.`,
  }
}
