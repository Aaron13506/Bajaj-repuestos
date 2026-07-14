/**
 * Genera una galería HTML para VERIFICAR que cada imagen subida a S3 corresponde a
 * su producto. Lee ScrapedProduct de la DB y arma tarjetas: imagen (imageS3Url) +
 * título + modelo + link al 99rpm original. Abrí data/scrape/verify.html en el navegador.
 *
 * Uso: pnpm exec tsx scripts/verify-scraped-images.ts
 */
import { PrismaClient } from '@prisma/client'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient()

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function main() {
  const prods = await prisma.scrapedProduct.findMany({
    orderBy: [{ model: 'asc' }, { slug: 'asc' }],
    select: { slug: true, title: true, model: true, sourceUrl: true, imageS3Url: true, totalInr: true },
  })
  const withImg = prods.filter((p) => p.imageS3Url).length

  const cards = prods
    .map(
      (p) => `<div class="c">
    ${p.imageS3Url ? `<img loading="lazy" src="${p.imageS3Url}" alt="${esc(p.slug)}">` : `<div class="noimg">SIN IMAGEN</div>`}
    <div class="t">${esc(p.title || p.slug)}</div>
    <div class="s">${p.model} · INR ${p.totalInr ?? '-'}</div>
    <a href="${p.sourceUrl}" target="_blank" rel="noopener">99rpm ↗</a>
  </div>`,
    )
    .join('\n')

  const html = `<!doctype html><meta charset="utf-8"><title>Verificar imágenes scrapeadas</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:16px;background:#fafafa}
  h1{font-size:18px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
  .c{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px;font-size:12px}
  .c img{width:100%;height:180px;object-fit:contain;background:#fff}
  .noimg{height:180px;display:grid;place-items:center;color:#b91c1c;background:#fef2f2;border-radius:4px}
  .t{font-weight:600;margin:6px 0 2px}
  .s{color:#6b7280}
  a{color:#2563eb;text-decoration:none;font-size:11px}
</style>
<h1>${prods.length} productos · ${withImg} con imagen en S3 · ${prods.length - withImg} sin imagen</h1>
<div class="grid">
${cards}
</div>`

  const out = path.join('data', 'scrape', 'verify.html')
  await writeFile(out, html)
  console.log(`✓ ${prods.length} productos (${withImg} con imagen) → ${out}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
