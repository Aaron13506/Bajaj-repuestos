/**
 * Carga data/scrape/products.json → tablas Scraped* (separadas del catálogo curado).
 * Además ASEGURA la imagen limpia (sin marca de agua) en data/99rpm/raw/: si ya la
 * tenemos la reusa, si no baja el ORIGINAL de 99rpm (media/catalog/product/x/y/…).
 *
 * Uso:
 *   pnpm exec tsx prisma/seed-scraped.ts                      # data/scrape/products.json
 *   pnpm exec tsx prisma/seed-scraped.ts --file=service-parts.json   # otro archivo (incremental)
 *
 * Es idempotente (upsert por sourceUrl), así que seedear un archivo parcial solo
 * agrega/actualiza esos productos; no borra los demás.
 */
import { PrismaClient, MotoModel } from '@prisma/client'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import path from 'node:path'

try { process.loadEnvFile() } catch {} // carga .env (S3_* y DATABASE_URL)

// DIRECT_URL no trae connection_limit=1, así permite varias conexiones en paralelo.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})
const CONCURRENCY = 8

/** Procesa `items` con `n` workers en paralelo (pool simple, sin dependencias). */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: n }, worker))
}
const BASE = 'https://www.99rpm.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const RAW_DIR = path.join('data', '99rpm', 'raw')

// ── Supabase Storage (API S3-compatible) ──
const BUCKET = process.env.S3_BUCKET_NAME!
const s3 = new S3Client({
  region: process.env.S3_REGION!,
  endpoint: process.env.S3_ENDPOINT_URL!,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
})
// URL pública: https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<key>
const PROJECT_REF = new URL(process.env.S3_ENDPOINT_URL!).hostname.split('.')[0]
const PUBLIC_BASE = `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/${BUCKET}`

/** Sube la imagen limpia al bucket (idempotente: si ya está, la reusa). */
async function uploadImage(name: string): Promise<{ key: string; url: string; uploaded: boolean } | null> {
  const key = `99rpm/${name}`
  const url = `${PUBLIC_BASE}/${key}`
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return { key, url, uploaded: false } // ya está en S3
  } catch {}
  try {
    const body = await readFile(path.join(RAW_DIR, name))
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body,
      ContentType: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      CacheControl: 'public, max-age=31536000',
    }))
    return { key, url, uploaded: true }
  } catch (e) {
    console.warn(`  S3 fail ${name}: ${(e as Error).message}`)
    return null
  }
}

/**
 * Asegura la imagen limpia local. Fallback en cadena:
 *   1) ¿ya la tengo en data/99rpm/raw/?  → 'local'
 *   2) si no, bajo el ORIGINAL sin marca de 99rpm (media/catalog/product/x/y/…, sin
 *      /cache/ y sin query → no pasa por el bot-gate)  → 'downloaded'
 *   3) si el original no existe (404) o no es JPEG → status del fallo, name=null.
 */
async function ensureImage(imagePath: string | null): Promise<{ name: string | null; status: string }> {
  if (!imagePath) return { name: null, status: 'no-path' }
  const name = imagePath.split('/').pop()!
  const dst = path.join(RAW_DIR, name)
  try {
    await access(dst)
    return { name, status: 'local' }
  } catch {}
  const res = await fetch(`${BASE}/media/catalog/product/${imagePath}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) return { name: null, status: `http-${res.status}` }
  const buf = Buffer.from(await res.arrayBuffer())
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8
  const isPng = buf[0] === 0x89 && buf[1] === 0x50
  if (!isJpg && !isPng) return { name: null, status: 'not-image' }
  await mkdir(RAW_DIR, { recursive: true })
  await writeFile(dst, buf)
  return { name, status: 'downloaded' }
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith('--file='))?.split('=')[1] ?? 'products.json'
  const products: any[] = JSON.parse(await readFile(path.join('data', 'scrape', fileArg), 'utf8'))
  console.log(`Fuente: data/scrape/${fileArg}`)
  let haveImg = 0, dlImg = 0, s3up = 0, parts = 0, done = 0
  const missing: string[] = []
  console.log(`Cargando ${products.length} productos en paralelo (x${CONCURRENCY}: imagen → S3 → DB)…`)

  await pool(products, CONCURRENCY, async (p) => {
    const img = await ensureImage(p.imagePath)
    if (img.name) { haveImg++; if (img.status === 'downloaded') dlImg++ }
    else missing.push(`${p.slug} (${img.status})`)

    // subir imagen limpia a S3 (Supabase Storage)
    const s3res = img.name ? await uploadImage(img.name) : null
    if (s3res?.uploaded) s3up++

    const model = (p.models?.[0] ?? null) as MotoModel | null
    if (!model) { console.warn(`  sin modelo: ${p.slug}`); return }
    if (p.models.length > 1) console.warn(`  OJO multi-modelo (${p.models.length}): ${p.slug}`)

    const data = {
      slug: p.slug,
      title: p.title,
      model,
      mainImageUrl: p.mainImageUrl ?? null,
      imageS3Key: s3res?.key ?? null,
      imageS3Url: s3res?.url ?? null,
      totalInr: p.totalInr ?? null,
      rawJson: { imagePath: p.imagePath ?? null, localImage: img.name, bundle: p.rawBundle ?? null },
    }
    const sp = await prisma.scrapedProduct.upsert({
      where: { sourceUrl: p.sourceUrl },
      create: { sourceUrl: p.sourceUrl, ...data },
      update: data,
    })

    // reemplazo completo (fuente de verdad = scrape). Borrar los subgrupos arrastra
    // las partes por cascade. NOTA: el cruce (peso/dim/margen) se recalcula aparte
    // con scripts/cross-ref.ts, así que re-seedear no pierde datos curados.
    await prisma.scrapedGroup.deleteMany({ where: { productId: sp.id } })

    // agrupar las partes por su groupTitle crudo, conservando el orden de aparición
    const byGroup = new Map<string, any[]>()
    for (const pt of (p.parts ?? [])) {
      const raw = pt.groupTitle ?? ''
      if (!byGroup.has(raw)) byGroup.set(raw, [])
      byGroup.get(raw)!.push(pt)
    }

    let gOrder = 0
    for (const [rawTitle, groupParts] of byGroup) {
      const sg = await prisma.scrapedGroup.create({
        data: {
          productId: sp.id,
          rawTitle,
          title: rawTitle.trim() || rawTitle, // nombre COMPLETO del subgrupo (el "|" aquí es categoría|contexto, no SKU)
          sortOrder: gOrder++,
        },
      })
      await prisma.scrapedPart.createMany({
        data: groupParts.map((pt: any) => ({
          groupId: sg.id,
          name: pt.name ?? '',
          sku: pt.sku ?? '',
          altSku: pt.altSku ?? null,
          priceInr: pt.priceInr ?? 0,
          qty: pt.qty ?? 1,
          sortOrder: pt.sortOrder ?? 0,
        })),
      })
      parts += groupParts.length
    }

    if (++done % 50 === 0 || done === products.length)
      console.log(`  [${done}/${products.length}] S3 ${s3up} subidas · ${parts} piezas`)
  })

  console.log(`✓ ${products.length} productos · ${parts} piezas`)
  console.log(`  imágenes: ${haveImg} listas (${dlImg} bajadas ahora) · ${missing.length} sin imagen`)
  console.log(`  S3: ${s3up} subidas ahora (resto ya estaba)`)
  if (missing.length) {
    console.log('  ── sin imagen (revisar a mano):')
    missing.forEach((m) => console.log('     ·', m))
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
