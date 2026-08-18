/**
 * Materializa el catálogo scrapeado (ScrapedProduct → ScrapedGroup → ScrapedPart)
 * dentro de las tablas OFICIALES (Product + ProductComponent), que son las que lee la UI.
 *
 *   ScrapedProduct (ensamble) → Product (isAssembly=true)
 *   ScrapedPart (parte)       → Product  — DEDUPLICADO por bajajCode (1 por SKU, reusado)
 *   subgrupo + qty            → ProductComponent (groupName = subgrupo, quantity, sortOrder)
 *
 * - Dedup por SKU: cada código = un solo Product, enlazado como hijo en todos los
 *   ensambles donde aparezca. Así el peso/dim curado se carga una vez por SKU.
 * - Overlay curado: si ya existe un Product con ese bajajCode (tus curados), NO se duplica;
 *   se reusa y se le rellenan nameEn/priceInr/sourceUrl si estaban vacíos (no toca peso/dim/margen).
 * - Partes sin SKU: 1 Product por aparición (no se pueden deduplicar).
 * - models de cada pieza = UNIÓN de los modelos de todos los ensambles que la usan (ej.
 *   una pastilla → [PULSAR_150_BS4, PULSAR_180_BS4_2017_19, ...]). De ahí sale la
 *   compatibilidad cruzada que muestra el armador.
 * - Precio/margen de las partes: quedan en 0 / null porque aún no tienen peso; se calculan
 *   cuando cargues peso por SKU (edición o import-por-bajajCode).
 *
 * Idempotente: ensambles se reusan por sourceUrl, partes por bajajCode. Re-correrlo continúa
 * donde quedó en vez de duplicar.
 *
 * Uso:
 *   pnpm materialize                      # todo el catálogo scrapeado
 *   pnpm materialize --model=BOXER_BM150  # solo esa moto
 *
 * `--model` existe porque agregar UNA moto no justifica barrer las ~1500 ensambles de
 * las demás. Acotar no cambia el resultado: los SKU que ya existen se reusan igual y el
 * PASS 1b les UNE la moto nueva sin pisar las que ya tenían.
 */
import { PrismaClient, type MotoModel } from '@prisma/client'
import { fullModel, parseModels, modelByLabel, sortModels } from '../lib/modelo'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})
const CONCURRENCY = 8

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => { while (i < items.length) await fn(items[i++]) }
  await Promise.all(Array.from({ length: n }, worker))
}

const norm = (s: string | null | undefined) => (s ?? '').toString().trim().toUpperCase()

// ScrapedProduct.model es el enum MotoModel; Product.compatibleModels guarda las
// ETIQUETAS legibles. fullModel (lib/modelo.ts) hace la traducción, que es la misma
// tabla que usa la UI para mostrarlas — así lo materializado y lo que se ve coinciden.

function partData(pt: { name: string; sku: string | null; priceInr: number | null; models?: MotoModel[]; discontinued?: boolean }) {
  const etiquetas = (pt.models ?? []).map(fullModel).join(', ') || null
  // sin peso ⇒ sin costo landed ⇒ price 0 y margin null (se completa al cargar peso por SKU)
  return {
    isAssembly: false,
    nameEs: pt.name || '(sin nombre)',
    nameEn: pt.name || null,
    bajajCode: pt.sku && pt.sku.trim() ? pt.sku.trim() : null,
    compatibleModels: etiquetas,
    priceInr: pt.priceInr ?? null,
    margin: null,
    landedCostUsd: null,
    price: 0,
    stock: 0,
    // Nace descontinuada si 99rpm ya la rotulaba: es el estado de fábrica, no algo que
    // pase después. La fecha es la de esta corrida — es cuándo nos enteramos, no cuándo
    // Bajaj dejó de fabricarla, que no lo publica nadie.
    discontinuedAt: pt.discontinued ? new Date() : null,
  }
}

async function main() {
  // ── caches para idempotencia ──
  const existingParts = await prisma.product.findMany({
    where: { bajajCode: { not: null } }, select: { id: true, bajajCode: true },
  })
  const partBySku = new Map<string, number>()
  for (const p of existingParts) partBySku.set(norm(p.bajajCode), p.id)
  const preExisting = new Set(partBySku.keys()) // curados previos, para el enrich

  const existingAsm = await prisma.product.findMany({
    where: { isAssembly: true }, select: { id: true, sourceUrl: true, imageUrl: true },
  })
  const asmByUrl = new Map<string, number>()
  const asmImg = new Map<string, string | null>() // para backfill de imageUrl sin pisar
  for (const a of existingAsm) if (a.sourceUrl) { asmByUrl.set(a.sourceUrl, a.id); asmImg.set(a.sourceUrl, a.imageUrl) }

  // ── árbol scrapeado (completo, o acotado a una moto con --model=) ──
  const modelArg = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] as MotoModel | undefined
  console.log(`Cargando árbol scrapeado${modelArg ? ` (solo ${modelArg})` : ''}…`)
  const sps = await prisma.scrapedProduct.findMany({
    where: modelArg ? { model: modelArg } : undefined,
    include: { groups: { orderBy: { sortOrder: 'asc' }, include: { parts: { orderBy: { sortOrder: 'asc' } } } } },
  })
  console.log(`  ${sps.length} ensambles cargados.`)
  if (sps.length === 0) { console.error('Nada que materializar — ¿el valor de --model existe?'); return }

  // ── PASS 1: crear un Product por SKU distinto ──
  // skuInfo = 1ª aparición por SKU · modelsBySku = unión de modelos de TODOS los ensambles
  // que usan ese SKU (para que la ficha de la pieza diga con qué modelos es compatible)
  const skuInfo = new Map<string, { name: string; sku: string; priceInr: number | null; sourceUrl: string }>()
  const modelsBySku = new Map<string, Set<MotoModel>>()
  // Discontinuado se acumula por OR sobre TODAS las apariciones del SKU: la misma pieza
  // está en varios ensambles y 99rpm no siempre la rotula en todos. Que la fábrica dejó de
  // producirla es un hecho de la pieza, así que alcanza con que lo diga una vez.
  const nlsBySku = new Set<string>()
  for (const sp of sps) {
    const pm = sp.model
    for (const g of sp.groups) for (const pt of g.parts) {
      const k = norm(pt.sku)
      if (!k) continue
      if (!skuInfo.has(k)) skuInfo.set(k, { name: pt.name, sku: pt.sku.trim(), priceInr: pt.priceInr, sourceUrl: sp.sourceUrl })
      if (pt.discontinued) nlsBySku.add(k)
      if (!modelsBySku.has(k)) modelsBySku.set(k, new Set())
      modelsBySku.get(k)!.add(pm)
    }
  }
  const toCreate = [...skuInfo.entries()].filter(([k]) => !partBySku.has(k))
  console.log(`SKU distintos: ${skuInfo.size} · a crear (nuevos): ${toCreate.length}`)

  const BATCH = 500
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const chunk = toCreate.slice(i, i + BATCH)
    await prisma.product.createMany({
      data: chunk.map(([k, info]) => partData({
        ...info,
        models: [...(modelsBySku.get(k) ?? [])],
        discontinued: nlsBySku.has(k),
      })),
      skipDuplicates: true,
    })
  }
  // rellenar ids nuevos
  const newSkus = toCreate.map(([, info]) => info.sku)
  for (let i = 0; i < newSkus.length; i += BATCH) {
    const chunk = newSkus.slice(i, i + BATCH)
    const rows = await prisma.product.findMany({ where: { bajajCode: { in: chunk } }, select: { id: true, bajajCode: true } })
    for (const r of rows) if (!partBySku.has(norm(r.bajajCode))) partBySku.set(norm(r.bajajCode), r.id)
  }

  // ── PASS 1b: enriquecer curados previos que aparecen en el scrape ──
  // En pool: es un round-trip a Supabase por SKU y en serie son minutos. Cada iteración
  // toca un id distinto, así que paralelizarlo no cruza escrituras.
  const toEnrich = [...skuInfo].filter(([k]) => preExisting.has(k))
  let enriched = 0
  let marcadas = 0
  await pool(toEnrich, CONCURRENCY, async ([k, info]) => {
    const id = partBySku.get(k)!
    const cur = await prisma.product.findUnique({ where: { id }, select: { nameEn: true, priceInr: true, sourceUrl: true, compatibleModels: true, discontinuedAt: true } })
    if (!cur) return
    const data: Record<string, unknown> = {}
    if (!cur.nameEn && info.name) data.nameEn = info.name
    // El scrape solo SUMA la marca, nunca la saca. Que 99rpm deje de mostrar el rótulo no
    // prueba que Bajaj volvió a fabricarla — puede ser que reordenaron la página, o que la
    // pieza dejó de listarse. Y desmarcar en silencio pisaría una decisión tomada a mano.
    // Revivir un SKU es manual, a propósito.
    if (nlsBySku.has(k) && cur.discontinuedAt == null) { data.discontinuedAt = new Date(); marcadas++ }
    if (cur.priceInr == null && info.priceInr != null) data.priceInr = info.priceInr
    if (!cur.sourceUrl && info.sourceUrl) data.sourceUrl = info.sourceUrl
    // unión: modelos ya curados + modelos del scrape (sin duplicar, sin pisar)
    // Unión con lo ya curado, sobre las ETIQUETAS: se sigue sin pisar lo cargado a mano,
    // solo se suman las motos que el scrape encontró y no estaban.
    const etiquetas = new Set(parseModels(cur.compatibleModels))
    const before = etiquetas.size
    for (const m of modelsBySku.get(k) ?? new Set<MotoModel>()) etiquetas.add(fullModel(m))
    if (etiquetas.size > before) data.compatibleModels = sortModels([...etiquetas].map(l => modelByLabel(l)?.id).filter((x): x is MotoModel => !!x)).map(fullModel).join(', ')
    if (Object.keys(data).length) { await prisma.product.update({ where: { id }, data }); enriched++ }
  })
  console.log(`Curados a revisar: ${toEnrich.length} · enriquecidos: ${enriched}`)
  console.log(`Descontinuados: ${nlsBySku.size} SKU rotulados por 99rpm · ${marcadas} marcados ahora (el resto ya lo estaba)`)

  // ── Reuse de piezas SIN SKU (idempotencia entre corridas) ──
  // Sin bajajCode no se puede deduplicar por SKU, así que las llaveamos por
  // (parentId, groupName, nameEs). Precargamos las que ya existen para reusarlas
  // en vez de crear un Product nuevo por corrida (lo que antes las triplicaba).
  const noSkuKey = (parentId: number, groupName: string, name: string) =>
    `${parentId} ${groupName} ${name || '(sin nombre)'}`
  const noSkuByKey = new Map<string, number>()
  {
    const existing = await prisma.productComponent.findMany({
      where: { child: { bajajCode: null, isAssembly: false } },
      select: { parentId: true, groupName: true, child: { select: { id: true, nameEs: true } } },
    })
    for (const l of existing) noSkuByKey.set(noSkuKey(l.parentId, l.groupName, l.child.nameEs), l.child.id)
  }

  // ── PASS 2: ensambles + enlaces ──
  let done = 0, links = 0, noSku = 0, imgFilled = 0
  await pool(sps, CONCURRENCY, async (sp) => {
    let parentId = asmByUrl.get(sp.sourceUrl)
    if (parentId == null) {
      const asm = await prisma.product.create({
        data: {
          isAssembly: true,
          nameEs: sp.title.split('|')[0].trim() || sp.title,
          nameEn: sp.title,
          sourceUrl: sp.sourceUrl,
          imageUrl: sp.imageS3Url ?? null,
          compatibleModels: fullModel(sp.model),
          margin: null, landedCostUsd: null, price: 0, stock: 0,
        },
      })
      parentId = asm.id
      asmByUrl.set(sp.sourceUrl, parentId)
    } else if (sp.imageS3Url && asmImg.get(sp.sourceUrl) !== sp.imageS3Url) {
      // backfill: ensamble ya existía sin imagen (o cambió) → rellenar desde el scrape
      await prisma.product.update({ where: { id: parentId }, data: { imageUrl: sp.imageS3Url } })
      asmImg.set(sp.sourceUrl, sp.imageS3Url)
      imgFilled++
    }

    const linkData: { parentId: number; childId: number; groupName: string; quantity: number; sortOrder: number }[] = []
    for (const g of sp.groups) {
      let so = 0
      for (const pt of g.parts) {
        const k = norm(pt.sku)
        let childId: number | undefined
        if (k) {
          childId = partBySku.get(k)
        } else {
          // Pieza sin SKU: reusar por (parent, grupo, nombre) si ya existe; si no, crear.
          const nkey = noSkuKey(parentId, g.title, pt.name)
          const existingId = noSkuByKey.get(nkey)
          if (existingId != null) {
            childId = existingId
          } else {
            const child = await prisma.product.create({ data: partData({ name: pt.name, sku: null, priceInr: pt.priceInr, models: [sp.model], discontinued: pt.discontinued }) })
            childId = child.id
            noSkuByKey.set(nkey, childId)
            noSku++
          }
        }
        if (childId == null) continue
        linkData.push({ parentId, childId, groupName: g.title, quantity: pt.qty ?? 1, sortOrder: so++ })
      }
    }
    if (linkData.length) {
      const res = await prisma.productComponent.createMany({ data: linkData, skipDuplicates: true })
      links += res.count
    }
    if (++done % 100 === 0 || done === sps.length) console.log(`  [${done}/${sps.length}] ensambles · ${links} enlaces`)
  })

  // ── resumen ──
  const totProd = await prisma.product.count()
  const totAsm = await prisma.product.count({ where: { isAssembly: true } })
  const totComp = await prisma.productComponent.count()
  console.log('\n✓ Materialización lista')
  console.log(`  Product total:        ${totProd}  (ensambles: ${totAsm}, partes: ${totProd - totAsm})`)
  console.log(`  ProductComponent:     ${totComp}`)
  console.log(`  partes sin SKU creadas este run: ${noSku}`)
  console.log(`  imágenes backfilleadas este run: ${imgFilled}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
