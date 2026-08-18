/**
 * Recupera las imágenes de los ensambles que quedaron SIN foto.
 *
 * Por qué existe: el scrape saca la ruta de la imagen de `og:image` / de una URL cacheada
 * de la página. Cuando ese día 99rpm sirvió el placeholder de Magento (o todavía no había
 * subido el diagrama), `imagePath` quedó en null y el ensamble se guardó sin imagen. La
 * página puede tener el diagrama HOY: este script vuelve a preguntar.
 *
 * Repite exactamente la cadena de prisma/seed-scraped.ts — misma regex, mismo original
 * limpio de media/catalog/product/, mismo bucket, misma key `99rpm/<archivo>` — para que la
 * imagen recuperada sea indistinguible de una scrapeada de entrada.
 *
 * Quirúrgico: solo toca ScrapedProduct.{mainImageUrl,imageS3Key,imageS3Url} y
 * Product.imageUrl, y solo donde están en null. NO crea, NO borra, NO toca precios ni
 * piezas. Idempotente: correrlo dos veces no cambia nada la segunda vez.
 *
 * Uso: pnpm recover:images          (--dry para solo listar, sin escribir)
 */
import { PrismaClient } from '@prisma/client'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})

const DRY = process.argv.includes('--dry')
const BASE = 'https://www.99rpm.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const RAW_DIR = path.join('data', '99rpm', 'raw')

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
const PROJECT_REF = new URL(process.env.S3_ENDPOINT_URL!).hostname.split('.')[0]
const PUBLIC_BASE = `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/${BUCKET}`

/** Idéntica a la del scraper: la ruta `x/y/archivo.jpg` sale de cualquier URL cacheada. */
function imagePath(html: string): string | null {
  const m = html.match(/cache\/\d+\/(?:image|small_image)\/[^"']*?\/([a-z0-9]\/[a-z0-9]\/[^"'?]+?\.(?:jpg|png))/i)
  return m ? m[1] : null
}

function meta(html: string, prop: string): string | undefined {
  return html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'i'))?.[1]
}

async function uploadImage(name: string, body: Buffer): Promise<{ key: string; url: string }> {
  const key = `99rpm/${name}`
  const url = `${PUBLIC_BASE}/${key}`
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return { key, url } // ya estaba en el bucket
  } catch {}
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body,
    ContentType: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    CacheControl: 'public, max-age=31536000',
  }))
  return { key, url }
}

async function main() {
  const sin = await prisma.scrapedProduct.findMany({
    where: { imageS3Url: null },
    select: { id: true, slug: true, model: true, sourceUrl: true },
    orderBy: [{ model: 'asc' }, { slug: 'asc' }],
  })
  console.log(`Ensambles sin imagen: ${sin.length}${DRY ? '  (DRY RUN — no escribe)' : ''}\n`)

  let recuperados = 0
  const sinFoto: string[] = []

  for (const p of sin) {
    const res = await fetch(p.sourceUrl, { headers: { 'User-Agent': UA } })
    if (!res.ok) { console.log(`  ✗ ${p.slug}: página http-${res.status}`); continue }
    const html = await res.text()

    const ip = imagePath(html)
    if (!ip) { sinFoto.push(p.slug); console.log(`  · ${p.slug}: 99rpm sigue sirviendo el placeholder`); continue }

    // El ORIGINAL (sin /cache/ y sin query) es el que viene limpio, sin marca de agua.
    const imgRes = await fetch(`${BASE}/media/catalog/product/${ip}`, { headers: { 'User-Agent': UA } })
    if (!imgRes.ok) { console.log(`  ✗ ${p.slug}: original http-${imgRes.status} (${ip})`); continue }
    const buf = Buffer.from(await imgRes.arrayBuffer())
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    if (!isJpg && !isPng) { console.log(`  ✗ ${p.slug}: la descarga no es una imagen (${ip})`); continue }

    const name = ip.split('/').pop()!
    console.log(`  ✓ ${p.slug} → ${ip} (${(buf.length / 1024).toFixed(0)}KB ${isPng ? 'png' : 'jpg'})`)
    if (DRY) { recuperados++; continue }

    await mkdir(RAW_DIR, { recursive: true })
    await writeFile(path.join(RAW_DIR, name), buf)
    const { key, url } = await uploadImage(name, buf)

    await prisma.scrapedProduct.update({
      where: { id: p.id },
      data: { imageS3Key: key, imageS3Url: url, mainImageUrl: meta(html, 'og:image') ?? `${BASE}/media/catalog/product/${ip}` },
    })
    // mismo cruce por sourceUrl que scripts/backfill-images.ts, y solo si sigue en null
    const upd = await prisma.product.updateMany({
      where: { sourceUrl: p.sourceUrl, isAssembly: true, imageUrl: null },
      data: { imageUrl: url },
    })
    console.log(`      subida a ${key} · Product.imageUrl actualizados: ${upd.count}`)
    recuperados++
  }

  const quedan = await prisma.scrapedProduct.count({ where: { imageS3Url: null } })
  console.log(`\nRecuperados: ${recuperados}`)
  console.log(`Sin foto en 99rpm (nada que recuperar): ${sinFoto.length}${sinFoto.length ? ` → ${sinFoto.join(', ')}` : ''}`)
  if (!DRY) console.log(`ScrapedProduct sin imagen ahora: ${quedan}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
