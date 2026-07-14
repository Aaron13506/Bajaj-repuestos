/**
 * Backfill QUIRÚRGICO de imágenes: copia ScrapedProduct.imageS3Url → Product.imageUrl
 * en los ensambles, cruzando por sourceUrl.
 *
 * Solo hace updateMany sobre la columna imageUrl (y solo donde está en null).
 * NO crea, NO borra, NO resetea, NO toca ningún otro campo. Idempotente.
 *
 * Uso: pnpm backfill:images
 */
import { PrismaClient } from '@prisma/client'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})

async function main() {
  const scraped = await prisma.scrapedProduct.findMany({
    where: { imageS3Url: { not: null } },
    select: { sourceUrl: true, imageS3Url: true },
  })
  console.log(`Ensambles scrapeados con imagen: ${scraped.length}`)

  let updated = 0
  for (const s of scraped) {
    const res = await prisma.product.updateMany({
      where: { sourceUrl: s.sourceUrl, isAssembly: true, imageUrl: null },
      data: { imageUrl: s.imageS3Url },
    })
    updated += res.count
  }

  const withImg = await prisma.product.count({ where: { isAssembly: true, imageUrl: { not: null } } })
  console.log(`Product.imageUrl rellenados este run: ${updated}`)
  console.log(`Ensambles con imagen ahora: ${withImg}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
