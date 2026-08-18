/**
 * Scraper de 99rpm.com para modelos Pulsar seleccionados.
 *
 * Estrategia:
 *   - Enumeración por MODELO (autoritativa): <listado>.html?bajaj_vehicle_type=<ID>
 *     paginado. Da el mapeo modelo → URLs de producto. Se recorren DOS listados:
 *       · parts.html         → los diagramas explotados (ensambles/bundles OEM)
 *       · service-parts.html → consumibles por modelo (filtro aire/aceite/gasolina,
 *                              pastillas del/tras, zapatas, bujías). También son bundles.
 *     El mismo filtro por vehicle_type da el modelo de cada consumible sin adivinar.
 *   - Cada página de producto es un "bundle" Magento: new Product.Bundle({...})
 *     con opciones (grupos) y selecciones (piezas: nombre, SKU(s), precio INR).
 *   - Categoría: se enriquece aparte con un crawl del árbol de categorías
 *     (mapa slug→categoría), porque la página de detalle no trae breadcrumb.
 *
 * Escribe a data/scrape/products.json (no toca la DB; eso lo hace seed-scraped.ts).
 *
 * Uso:
 *   pnpm exec tsx scripts/scrape-99rpm.ts                 # todo (ambos listados)
 *   pnpm exec tsx scripts/scrape-99rpm.ts --probe         # 1 modelo, 1 pág, 3 productos
 *   pnpm exec tsx scripts/scrape-99rpm.ts --models=562,557 --max-pages=2
 *   # solo consumibles, a un archivo aparte (incremental, no re-scrapea los diagramas):
 *   pnpm exec tsx scripts/scrape-99rpm.ts --listings=service-parts.html --out=service-parts.json
 */
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const BASE = 'https://www.99rpm.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const DELAY_MS = 700 // cortesía entre requests

// vehicle_type ID → valor del enum MotoModel (Prisma)
const MODELS: Record<number, string> = {
  595: 'PULSAR_N250_USD_FORK_2024_25',
  579: 'PULSAR_N250_DUAL_ABS_2022_23',
  562: 'PULSAR_N250_SINGLE_ABS_2021_23',
  580: 'PULSAR_NS200_USD_FORK_2023',
  557: 'PULSAR_NS200_BS6_2021_23',
  558: 'PULSAR_NS200_BS6_2020',
  497: 'PULSAR_NS200_BS4_2017_19',
  442: 'PULSAR_200NS_BS3_2012_16',
  572: 'PULSAR_N160_SINGLE_ABS_2022_23',
  574: 'PULSAR_N160_DUAL_ABS_2022_23',
  513: 'PULSAR_180_BS4_2017_19',
  539: 'PULSAR_180_BS3_2009_16_UG4',
  515: 'PULSAR_150_BS4',
  449: 'PULSAR_150_UG4',
}

// Listados que se enumeran por vehicle_type. Ambos devuelven páginas-bundle.
const DEFAULT_LISTINGS = ['parts.html', 'service-parts.html']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 99rpm bloquea las URLs con query (?) con un bot-gate (302 → /gate.php). Visitar
// una página SIN query setea una cookie de sesión que abre el gate; la reusamos en
// todos los requests. Sin esto, `?bajaj_vehicle_type=<id>` devuelve 0 productos.
let COOKIE = ''
async function primeCookie(): Promise<void> {
  const res = await fetch(`${BASE}/bajaj/parts.html`, { headers: { 'User-Agent': UA } })
  const sc = (res.headers as any).getSetCookie?.() ?? []
  COOKIE = sc.map((c: string) => c.split(';')[0]).join('; ')
  await res.text()
  process.stderr.write(`[cookie primada: ${COOKIE ? COOKIE.split('; ').length + ' cookie(s)' : 'NINGUNA'}]\n`)
}

async function fetchText(url: string, tries = 3): Promise<string> {
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...(COOKIE ? { Cookie: COOKIE } : {}) },
        redirect: 'follow',
      })
      if (res.ok) return await res.text()
      if (res.status === 404) return ''
      throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      if (a === tries) throw e
      await sleep(DELAY_MS * a * 2)
    }
  }
  return ''
}

/** Enlaces de producto en un listado. Solo los del grid (`<h2 class="product-name">
 * <a href=...>`), no los de navegación/categoría (parts.html, oils-fluids.html, etc.). */
function productLinks(html: string): string[] {
  const re = /class="product-name"><a href="(https:\/\/www\.99rpm\.com\/bajaj\/[a-z0-9-]+\.html)"/g
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.add(m[1])
  return [...out]
}

/** Extrae el JSON balanceado que sigue a `new Product.Bundle(`. */
function extractBundle(html: string): any | null {
  const marker = 'new Product.Bundle('
  const i = html.indexOf(marker)
  if (i < 0) return null
  let j = html.indexOf('{', i)
  if (j < 0) return null
  const start = j
  let depth = 0, inStr = false, esc = false
  for (; j < html.length; j++) {
    const c = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, j + 1)) } catch { return null }
    }
  }
  return null
}

function meta(html: string, prop: string): string | undefined {
  const m = html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'i'))
  return m?.[1]
}

/**
 * Ruta de la imagen del diagrama en 99rpm, forma `x/y/archivo.jpg`. La sacamos de
 * cualquier URL cacheada de la página; el ORIGINAL (sin marca de agua) vive en
 * media/catalog/product/<x>/<y>/<archivo>.jpg (solo las versiones cacheadas traen marca).
 */
function imagePath(html: string): string | null {
  // .jpg o .png. El patrón x/y/ (un char / un char) excluye el placeholder de
  // Magento (images/catalog/product/placeholder/…), que no tiene esa forma.
  const m = html.match(/cache\/\d+\/(?:image|small_image)\/[^"']*?\/([a-z0-9]\/[a-z0-9]\/[^"'?]+?\.(?:jpg|png))/i)
  return m ? m[1] : null
}

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/**
 * Un token del nombre que en realidad es el código Bajaj de la pieza.
 *
 * INSENSIBLE A LA CAJA a propósito: 99rpm no es consistente y publica el mismo tipo de
 * código en mayúscula ("DH101509") o capitalizado ("Dh101414"). Cuando esto exigía
 * mayúsculas, el capitalizado no se reconocía como código, se quedaba adentro del nombre
 * y la pieza nacía SIN SKU — invisible para el cruce con la lista del proveedor, y
 * duplicada una vez por cada ensamble que la usa (materialize solo deduplica por código).
 *
 * El dígito obligatorio es lo que sostiene el relajo de la caja: sin él, una palabra
 * suelta del nombre partida por "|" ("Silver", "Rubber") pasaría por código. Todos los
 * códigos Bajaj del catálogo tienen al menos uno.
 */
const isSku = (s: string) => /^[A-Za-z0-9]{5,10}$/.test(s.trim()) && /\d/.test(s)

/**
 * Selecciones que 99rpm rotula como descontinuadas.
 *
 * El dato NO está en el JSON del bundle: la página lo agrega al final del `<label>` de cada
 * selección, como texto plano — "… ₹ 241</span> (Discontinued/Supply-Disruption/NLS)". Por
 * eso hay que leer el HTML aunque el resto de la pieza salga del JSON.
 *
 * Devuelve ids de selección (`bundle-option-<opción>-<selección>`), que son las mismas
 * claves con las que vienen las selecciones en el bundle.
 */
function discontinuedSelections(html: string): Set<string> {
  const out = new Set<string>()
  // El id aparece dos veces por pieza (en el <input> y en el <label>); las dos capturas
  // terminan leyendo el mismo texto hasta </label>, así que el Set alcanza para dedup.
  const re = /bundle-option-\d+-(\d+)"[^>]*>([\s\S]{0,600}?)<\/label>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (/Discontinued|Supply-Disruption|\bNLS\b/i.test(m[2])) out.add(m[1])
  }
  return out
}

interface Part { groupTitle: string; name: string; sku: string; altSku?: string; priceInr: number; qty: number; sortOrder: number; discontinued: boolean }

/** Aplana el bundle Magento en grupos/piezas. */
function parseBundle(bundle: any, nls: Set<string> = new Set()): { parts: Part[]; totalInr: number } {
  const parts: Part[] = []
  const options = bundle?.options ?? {}
  const opts = Object.values<any>(options).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  let sort = 0
  for (const opt of opts) {
    const groupTitle = clean(String(opt.title ?? ''))
    for (const [selId, sel] of Object.entries<any>(opt.selections ?? {})) {
      const raw = String(sel.name ?? '')
      const toks = raw.split('|').map((t) => t.trim()).filter(Boolean)
      const skus = toks.filter(isSku)
      const nameToks = toks.filter((t) => !isSku(t))
      parts.push({
        groupTitle,
        name: clean(nameToks.join(' | ')) || clean(raw),
        // En MAYÚSCULA: el código es el mismo lo escriba 99rpm como lo escriba, y todo el
        // cruce por SKU (catálogo, listas de proveedor) compara normalizado a mayúscula.
        sku: (skus[0] ?? '').toUpperCase(),
        altSku: skus[1]?.toUpperCase(),
        priceInr: Math.round(Number(sel.price ?? 0)),
        qty: Number(sel.qty ?? 1),
        sortOrder: sort++,
        // Bajaj dejó de fabricarla: no la consigue ningún proveedor, así que viaja con la
        // pieza y no con el ensamble que la contiene.
        discontinued: nls.has(selId),
      })
    }
  }
  const totalInr = parts.reduce((s, p) => s + p.priceInr * p.qty, 0)
  return { parts, totalInr }
}

function slugOf(url: string): string {
  return url.replace(/.*\/bajaj\//, '').replace(/\.html$/, '')
}

async function scrapeListing(listing: string, id: number, maxPages: number): Promise<string[]> {
  const urls = new Set<string>()
  for (let p = 1; p <= maxPages; p++) {
    const url = `${BASE}/bajaj/${listing}?bajaj_vehicle_type=${id}${p > 1 ? `&p=${p}` : ''}`
    const html = await fetchText(url)
    await sleep(DELAY_MS)
    const links = productLinks(html)
    const before = urls.size
    links.forEach((l) => urls.add(l))
    // fin: página sin productos nuevos
    if (links.length === 0 || urls.size === before) break
  }
  return [...urls]
}

async function scrapeProduct(url: string): Promise<any | null> {
  const html = await fetchText(url)
  if (!html) return null
  const bundle = extractBundle(html)
  if (!bundle) return null
  const { parts, totalInr } = parseBundle(bundle, discontinuedSelections(html))
  return {
    sourceUrl: url,
    slug: slugOf(url),
    title: clean(meta(html, 'og:title') ?? html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1] ?? ''),
    mainImageUrl: meta(html, 'og:image') ?? null,
    imagePath: imagePath(html), // x/y/archivo.jpg → original limpio en media/catalog/product/
    totalInr,
    parts,
    rawBundle: bundle,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const probe = args.includes('--probe')
  const modelsArg = args.find((a) => a.startsWith('--models='))?.split('=')[1]
  const maxPagesArg = args.find((a) => a.startsWith('--max-pages='))?.split('=')[1]
  const maxProdArg = args.find((a) => a.startsWith('--max-products='))?.split('=')[1]
  const listingsArg = args.find((a) => a.startsWith('--listings='))?.split('=')[1]
  const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1]

  let ids = Object.keys(MODELS).map(Number)
  if (modelsArg) ids = modelsArg.split(',').map(Number)
  if (probe) ids = [562] // N250 Single ABS
  const maxPages = maxPagesArg ? Number(maxPagesArg) : probe ? 1 : 50
  const maxProducts = maxProdArg ? Number(maxProdArg) : probe ? 3 : Infinity
  const listings = listingsArg ? listingsArg.split(',') : DEFAULT_LISTINGS

  await primeCookie() // abre el bot-gate para poder filtrar por modelo (?bajaj_vehicle_type=)

  // 1) modelo → URLs (uniendo todos los listados; un consumible por modelo cae en su enum)
  const urlModels = new Map<string, Set<string>>() // url → set(enum)
  for (const id of ids) {
    const enumVal = MODELS[id]
    for (const listing of listings) {
      process.stderr.write(`[modelo ${id} ${enumVal}] ${listing} listando...\n`)
      const urls = await scrapeListing(listing, id, maxPages)
      process.stderr.write(`  ${urls.length} productos\n`)
      for (const u of urls) {
        if (!urlModels.has(u)) urlModels.set(u, new Set())
        urlModels.get(u)!.add(enumVal)
      }
    }
  }

  // 2) detalle de cada producto único
  let allUrls = [...urlModels.keys()]
  if (allUrls.length > maxProducts) allUrls = allUrls.slice(0, maxProducts)
  process.stderr.write(`\nDescargando ${allUrls.length} productos únicos...\n`)
  const products: any[] = []
  let n = 0
  for (const url of allUrls) {
    const prod = await scrapeProduct(url)
    await sleep(DELAY_MS)
    n++
    if (!prod) { process.stderr.write(`  [${n}] SIN bundle: ${url}\n`); continue }
    prod.models = [...urlModels.get(url)!]
    products.push(prod)
    const nls = prod.parts.filter((p: Part) => p.discontinued).length
    process.stderr.write(`  [${n}/${allUrls.length}] ${prod.slug} · ${prod.parts.length} piezas · INR ${prod.totalInr} · ${prod.models.length} modelos${nls ? ` · ${nls} descontinuadas` : ''}\n`)
  }

  const outDir = path.join(process.cwd(), 'data', 'scrape')
  await mkdir(outDir, { recursive: true })
  const outName = outArg ?? (probe ? 'probe.json' : 'products.json')
  const outFile = path.join(outDir, outName)
  await writeFile(outFile, JSON.stringify(products, null, 2))
  // Los SKU descontinuados se cuentan ÚNICOS: la misma pieza aparece en varios ensambles y
  // el número que importa es cuántas piezas del catálogo dejaron de fabricarse.
  const nlsSkus = new Set<string>()
  for (const p of products) for (const part of p.parts as Part[]) if (part.discontinued && part.sku) nlsSkus.add(part.sku)
  process.stderr.write(`\n✓ ${products.length} productos → ${outFile}\n`)
  process.stderr.write(`  ${nlsSkus.size} SKU únicos rotulados como descontinuados por 99rpm\n`)
}

main().catch((e) => { console.error(e); process.exit(1) })
