/**
 * Cruza mi catálogo curado (Product) con el catálogo scrapeado (ScrapedPart) por SKU.
 * Para cada Product con bajajCode, copia los datos FÍSICOS que valen — peso y
 * dimensiones — sobre TODAS las partes scrapeadas con ese mismo SKU (una pieza física
 * puede aparecer en varios ensambles/modelos), y deja la traza en matchedProductId.
 *
 * El margen NO se cruza: es una decisión de negocio (default global en Config, editable
 * por parte), así que re-correr esto nunca pisa un margen ajustado a mano.
 *
 * Es idempotente y re-ejecutable: cada vez que agregues/midas un producto nuevo con
 * un SKU que ya está en lo scrapeado, corré esto de nuevo y se rellena solo.
 *
 * Uso: pnpm cross-ref
 */
import { PrismaClient } from '@prisma/client'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})

async function main() {
  // solo productos curados que tengan algo que aportar (SKU + al menos peso o dim)
  const curated = await prisma.product.findMany({
    where: { bajajCode: { not: null } },
    select: { id: true, bajajCode: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
  })
  console.log(`${curated.length} productos curados con SKU. Cruzando…`)

  let skusMatched = 0, partsUpdated = 0, skusSinMatch = 0
  for (const c of curated) {
    const sku = c.bajajCode!.trim()
    if (!sku) continue
    const res = await prisma.scrapedPart.updateMany({
      where: { sku },
      data: {
        weightGrams: c.weightGrams,
        dimL: c.dimL,
        dimA: c.dimA,
        dimH: c.dimH,
        matchedProductId: c.id,
      },
    })
    if (res.count > 0) { skusMatched++; partsUpdated += res.count }
    else skusSinMatch++
  }

  const totalParts = await prisma.scrapedPart.count()
  const conDatos = await prisma.scrapedPart.count({ where: { matchedProductId: { not: null } } })

  console.log(`✓ ${skusMatched}/${curated.length} SKU curados hicieron match`)
  console.log(`  ${partsUpdated} filas de parte actualizadas con peso/dim`)
  console.log(`  ${skusSinMatch} SKU curados sin aparición en lo scrapeado`)
  console.log(`  cobertura: ${conDatos}/${totalParts} partes scrapeadas ya tienen datos curados`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
