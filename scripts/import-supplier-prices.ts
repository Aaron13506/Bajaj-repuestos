/**
 * Importa la lista de precios EXW de un distribuidor (Excel/CSV, precios en USD) a
 * SupplierPrice, para un proveedor de origen India.
 *
 * SOLO RELLENA SKU QUE YA ESTÁN EN EL CATÁLOGO: un SKU de la lista que no matchee un
 * Product.bajajCode se reporta y se descarta — este script nunca crea productos. Una
 * pieza sin peso ni medidas no puede costearse, así que darla de alta acá solo dejaría
 * filas que calcLanded no sabe resolver.
 *
 * Los precios entran con isLanded=false: son costo de ORIGEN (EXW India), equivalente
 * a Product.priceInr pero en dólares, así que calcLanded les sigue sumando Shoppre +
 * seguro + marítimo encima. Ver lib/calc.ts.
 *
 * Junto al precio se importa el MOQ (cantidad mínima de compra, "VEH_DLR Set Qty"): el
 * precio es POR PIEZA, el MOQ dice cuántas piezas hay que llevar como mínimo. Van juntos
 * porque separados mienten: una pieza de US$0,40 con mínimo de 50 no cuesta US$0,40, la
 * compra mínima son US$20. Ver SupplierPrice.moq en prisma/schema.prisma.
 *
 * Es un import de una sola vez, pero idempotente: re-correrlo con el mismo archivo
 * deja la base igual (upsert por (productId, supplierId)).
 *
 * Uso:
 *   npx tsx scripts/import-supplier-prices.ts --file=<ruta> --inspect
 *   npx tsx scripts/import-supplier-prices.ts --file=<ruta> --supplier="Nombre"            (simulacro)
 *   npx tsx scripts/import-supplier-prices.ts --file=<ruta> --supplier="Nombre" --commit   (escribe)
 *
 * Opciones:
 *   --inspect             Lista hojas, cabeceras y primeras filas. No toca la base.
 *   --sheet=<nombre|N>    Hoja a leer (nombre o índice 1-based). Default: la primera.
 *   --header-row=N        Fila de cabeceras, 1-based. Default: la autodetecta (salta títulos).
 *   --sku-col=<hdr|letra> Columna del SKU (cabecera exacta o letra de Excel). Default: autodetecta.
 *   --price-col=<hdr|letra> Columna del precio USD. Default: autodetecta.
 *   --moq-col=<hdr|letra> Columna de la cantidad mínima de compra (ej. "VEH_DLR Set Qty").
 *                         Default: autodetecta. Alias histórico: --qty-col.
 *   --sin-moq             No toca la columna moq (importa solo precios).
 *   --supplier=<nombre>   Proveedor destino. Si no existe se crea con origen='india'.
 *   --decimal-comma       Fuerza "1.234,56". Normalmente NO hace falta: se infiere del archivo.
 *   --loose               Si el SKU no matchea exacto, reintenta ignorando guiones/espacios/puntos.
 *   --commit              Escribe. Sin esto es simulacro (default) y no toca nada.
 *
 * Notas sobre listas tipo "Spares Parts Price List" (Bajaj/KTM):
 *   - La fila 1 suele ser el título y las cabeceras están en la 2 → se autodetecta.
 *   - Las columnas ocultas no molestan: cada celda trae su columna real (r="M3"), así
 *     que "Price/pcs in USD" en M se ubica igual aunque I–L estén escondidas.
 *   - El precio es POR PIEZA. "VEH_DLR Set Qty" (VEHicle DeaLeR) es el paquete con el
 *     que Bajaj despacha a sus concesionarios, y se toma como la cantidad mínima de
 *     compra. No es un factor del precio: no se multiplica nada (SupplierPrice.priceUsd
 *     es por unidad, igual que Product.priceInr). Se guarda aparte en SupplierPrice.moq.
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { basename } from 'node:path'

try { process.loadEnvFile() } catch {}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})

// Lote del INSERT ... ON CONFLICT. 500 filas × 4 parámetros queda muy por debajo del
// tope de 65535 parámetros de Postgres y evita 40k round-trips contra Supabase.
const CHUNK = 500

// ─────────────────────────────────────────────────────────────────────────────
// Lectura de .xlsx sin dependencias
//
// Un .xlsx es un ZIP de XML. Traer una librería (y su árbol de deps) para un import
// que se corre una vez no se paga; leer el ZIP con zlib y sacar celdas con regex sí
// alcanza, porque solo necesitamos texto y números de una grilla plana.
// ─────────────────────────────────────────────────────────────────────────────

/** Descomprime el ZIP a un mapa ruta → contenido. Sin ZIP64: un xlsx de 40k filas
 *  no se acerca ni a 4 GB ni a 65535 entradas. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()

  // El End Of Central Directory está al final, pero puede tener hasta 64 KB de
  // comentario detrás, así que se busca la firma hacia atrás.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('No parece un archivo ZIP/XLSX válido (falta el EOCD).')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method   = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen  = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const cmtLen   = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + cmtLen

    // El header local repite el nombre y los extras, con largos propios: hay que
    // releerlos ahí para saber dónde arranca la data comprimida.
    const lNameLen  = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw))
  }
  return files
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))
  return m ? decodeXml(m[1]) : null
}

/** "BC" → 54. Las celdas traen su columna como letra en r="BC12". */
function colToIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function indexToCol(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  }
  return s
}

/** Tabla de strings compartida. El orden ES el índice al que apuntan las celdas t="s",
 *  así que las <si/> vacías tienen que ocupar su lugar igual. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const si = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = si.exec(xml))) {
    if (m[1] == null) { out.push(''); continue }
    // Un <si> con formato mixto se parte en varios <r><t>…</t></r>: se concatenan.
    let s = ''
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let tm: RegExpExecArray | null
    while ((tm = t.exec(m[1]))) s += tm[1]
    out.push(decodeXml(s))
  }
  return out
}

type Row = (string | null)[]

/** Devuelve la hoja como matriz densa. Las celdas vacías quedan en null y las filas
 *  saltadas se rellenan, para que los índices de columna sean estables. */
function parseSheet(xml: string, shared: string[]): Row[] {
  const rows: Row[] = []
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null

  while ((rm = rowRe.exec(xml))) {
    const rowNum = parseInt(attr(rm[1], 'r') ?? '0') || rows.length + 1
    const cells: Row = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm: RegExpExecArray | null

    while ((cm = cellRe.exec(rm[2]))) {
      const ref = attr(cm[1], 'r')
      const idx = ref ? colToIndex(ref.replace(/\d+/g, '')) : cells.length
      const type = attr(cm[1], 't')
      const body = cm[2] ?? ''
      let value: string | null = null

      if (type === 'inlineStr') {
        let s = ''
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g
        let tm: RegExpExecArray | null
        while ((tm = t.exec(body))) s += tm[1]
        value = decodeXml(s)
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)
        if (v) {
          const raw = decodeXml(v[1])
          value = type === 's' ? (shared[parseInt(raw)] ?? '') : raw
        }
      }

      while (cells.length < idx) cells.push(null)
      cells[idx] = value
    }

    while (rows.length < rowNum - 1) rows.push([])
    rows[rowNum - 1] = cells
  }
  return rows
}

interface Sheet { name: string; rows: Row[] }

function readXlsx(path: string): Sheet[] {
  const zip = readZip(readFileSync(path))
  const get = (p: string) => zip.get(p)?.toString('utf8') ?? ''

  const shared = parseSharedStrings(get('xl/sharedStrings.xml'))

  // rId → ruta del XML de la hoja
  const rels = new Map<string, string>()
  const relRe = /<Relationship\b([^>]*)\/>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(get('xl/_rels/workbook.xml.rels')))) {
    const id = attr(m[1], 'Id')
    const target = attr(m[1], 'Target')
    if (id && target) rels.set(id, target.replace(/^\//, '').replace(/^xl\//, ''))
  }

  const sheets: Sheet[] = []
  const sheetRe = /<sheet\b([^>]*)\/>/g
  while ((m = sheetRe.exec(get('xl/workbook.xml')))) {
    const name = attr(m[1], 'name') ?? `Hoja ${sheets.length + 1}`
    const rid = attr(m[1], 'r:id') ?? attr(m[1], 'id')
    const target = rid ? rels.get(rid) : null
    const xml = target ? get(`xl/${target}`) : ''
    if (xml) sheets.push({ name, rows: parseSheet(xml, shared) })
  }
  if (sheets.length === 0) throw new Error('El archivo no tiene hojas legibles.')
  return sheets
}

/** CSV RFC4180 (comillas dobles, saltos de línea dentro de comillas). Detecta ; vs , */
function readCsv(path: string): Sheet[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const head = text.slice(0, text.indexOf('\n') + 1 || text.length)
  const sep = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ','

  const rows: Row[] = []
  let row: Row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return [{ name: basename(path), rows }]
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de SKU y precio
// ─────────────────────────────────────────────────────────────────────────────

const normSku = (s: string) => s.trim().toUpperCase()
/** Match tolerante: el distribuidor puede escribir "JR-16 1036" y el catálogo "JR161036". */
const looseSku = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Un número tal como lo guarda el XML de una celda numérica: SIEMPRE con punto, y a
 *  veces en notación científica (1.92E-2). Que la planilla lo muestre como "33,26" es
 *  formato de pantalla, no el dato. */
const RAW_NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

function parsePrice(raw: string, decimalComma: boolean): number | null {
  const s0 = raw.trim()
  if (!s0) return null
  // Valor crudo de celda numérica: se toma tal cual. Este atajo es la red de seguridad
  // contra el error de 100x que causaría aplicarle --decimal-comma a un "33.26" real.
  if (RAW_NUMBER.test(s0)) return parseFloat(s0)

  let s = s0.replace(/[^\d.,\-]/g, '')           // fuera $, USD, espacios, nbsp
  if (!s) return null
  s = decimalComma ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/** Decide si el archivo usa coma decimal, mirando los valores en vez de creerle al
 *  usuario: gana el separador que más veces aparece como cola de 1-2 dígitos
 *  ("33,26" → coma; "1,234.50" → punto). Solo importa para celdas de TEXTO; las
 *  numéricas ya salen resueltas por RAW_NUMBER. */
function inferDecimalComma(samples: string[]): boolean {
  let coma = 0, punto = 0
  for (const s of samples) {
    if (RAW_NUMBER.test(s.trim())) continue
    if (/,\d{1,2}$/.test(s.trim())) coma++
    else if (/\.\d{1,2}$/.test(s.trim())) punto++
  }
  return coma > punto
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** MOQ: cantidad mínima de compra, entero ≥ 1. Se ignora la parte decimal de un "1.0" de
 *  Excel, pero se descarta cualquier cosa que no sea una cantidad (vacío, 0, negativo,
 *  texto): un MOQ inventado obliga a comprar de más, así que ante la duda se guarda null. */
function parseMoq(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const n = parseFloat(RAW_NUMBER.test(s) ? s : s.replace(/[^\d.,\-]/g, '').replace(',', '.'))
  if (!Number.isFinite(n) || n < 1) return null
  return Math.round(n)
}

/** Los reportes se abren en Excel/Notepad: sin BOM, Excel los lee como ANSI y rompe
 *  los acentos de los nombres. */
function writeReport(path: string, body: string): void {
  writeFileSync(path, '﻿' + body, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────────

interface Args { [k: string]: string | boolean }

function parseArgs(): Args {
  const args: Args = {}
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=([\s\S]*))?$/)
    if (m) args[m[1]] = m[2] ?? true
  }
  return args
}

const SKU_HINTS   = [/^(sku|c[oó]digo|codigo|code|part\s*(no|number|code)?|item\s*code|bajaj)/i]
// Primero la columna que dice dólares: una lista puede tener MRP en ₹ al lado del USD.
const PRICE_HINTS = [/(usd|d[oó]lar|\$)/i, /(price|precio|rate|amount|cost|costo)/i]
const MOQ_HINTS   = [/(set\s*qty|qty\s*set|múltiplo|multiplo|moq|pack|min.*(order|compra))/i]

/** Fila de cabeceras. Estas listas suelen abrir con una fila de título suelta
 *  ("Spares Parts Price List as of …"), así que se busca la primera fila que tenga a
 *  la vez algo que parezca SKU y algo que parezca precio. */
function findHeaderRow(rows: Row[]): number {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const cells = (rows[i] ?? []).map(c => (c ?? '').replace(/\s+/g, ' ').trim())
    const hit = (hints: RegExp[]) => cells.some(c => hints.some(h => h.test(c)))
    if (hit(SKU_HINTS) && hit(PRICE_HINTS)) return i + 1
  }
  return 1
}

/** Ubica una columna por letra de Excel ("D"), por cabecera exacta, o por heurística.
 *  Los `hints` se prueban en orden de preferencia: una lista puede traer dos columnas
 *  de precio (₹ y US$) y hay que quedarse con la de dólares. */
function resolveColumn(spec: string | undefined, headers: string[], hints: RegExp[], what: string): number {
  if (spec) {
    if (/^[A-Za-z]{1,3}$/.test(spec) && !headers.some(h => h.toLowerCase() === spec.toLowerCase())) {
      return colToIndex(spec.toUpperCase())
    }
    const i = headers.findIndex(h => h.trim().toLowerCase() === spec.trim().toLowerCase())
    if (i < 0) throw new Error(`No encontré la columna ${what} "${spec}". Cabeceras: ${headers.join(' | ')}`)
    return i
  }
  let i = -1
  for (const hint of hints) {
    i = headers.findIndex(h => hint.test(h.trim()))
    if (i >= 0) break
  }
  if (i < 0) {
    throw new Error(
      `No pude autodetectar la columna de ${what}. Pasala a mano con --${what}-col=<cabecera|letra>.\n` +
      `Cabeceras encontradas: ${headers.map((h, j) => `${indexToCol(j)}:"${h}"`).join(' | ')}`,
    )
  }
  return i
}

async function main() {
  const args = parseArgs()
  const file = args.file as string
  if (!file) throw new Error('Falta --file=<ruta al .xlsx o .csv>')

  const sheets = /\.csv$/i.test(file) ? readCsv(file) : readXlsx(file)

  // ── --inspect: mirar el archivo antes de decidir columnas ──────────────────
  if (args.inspect) {
    console.log(`\n${basename(file)} — ${sheets.length} hoja(s)\n`)
    for (const s of sheets) {
      const filled = s.rows.filter(r => r.some(c => c != null && c !== '')).length
      console.log(`── "${s.name}" — ${s.rows.length} filas (${filled} con datos)`)
      for (let i = 0; i < Math.min(6, s.rows.length); i++) {
        const cells = s.rows[i].slice(0, 12).map((c, j) => `${indexToCol(j)}:${c ?? ''}`)
        console.log(`   ${String(i + 1).padStart(3)} │ ${cells.join(' │ ')}`)
      }
      console.log()
    }
    return
  }

  // ── Hoja y columnas ────────────────────────────────────────────────────────
  const sheetArg = args.sheet as string | undefined
  const sheet = !sheetArg
    ? sheets[0]
    : /^\d+$/.test(sheetArg)
      ? sheets[parseInt(sheetArg) - 1]
      : sheets.find(s => s.name.trim().toLowerCase() === sheetArg.trim().toLowerCase())
  if (!sheet) throw new Error(`No encontré la hoja "${sheetArg}". Hay: ${sheets.map(s => s.name).join(', ')}`)

  const headerRow = parseInt((args['header-row'] as string) ?? String(findHeaderRow(sheet.rows)))
  const headers = (sheet.rows[headerRow - 1] ?? []).map(c => (c ?? '').replace(/\s+/g, ' ').trim())
  const skuIdx = resolveColumn(args['sku-col'] as string, headers, SKU_HINTS, 'sku')
  const priceIdx = resolveColumn(args['price-col'] as string, headers, PRICE_HINTS, 'price')
  // MOQ: si el usuario nombra la columna, tiene que existir (error si no); si no la
  // nombra se autodetecta y su ausencia es tolerable — hay listas que no lo declaran.
  const moqSpec = (args['moq-col'] ?? args['qty-col']) as string | undefined
  const moqIdx = args['sin-moq']
    ? -1
    : moqSpec
      ? resolveColumn(moqSpec, headers, MOQ_HINTS, 'moq')
      : headers.findIndex(h => MOQ_HINTS.some(q => q.test(h)))

  // La coma decimal se infiere del propio archivo salvo que se fuerce a mano.
  const priceSamples: string[] = []
  for (let r = headerRow; r < sheet.rows.length && priceSamples.length < 200; r++) {
    const v = sheet.rows[r]?.[priceIdx]
    if (v) priceSamples.push(v)
  }
  const decimalComma = args['decimal-comma'] ? true : inferDecimalComma(priceSamples)

  console.log(`Hoja "${sheet.name}" — cabeceras en la fila ${headerRow}`)
  console.log(`  SKU: ${indexToCol(skuIdx)} ("${headers[skuIdx] ?? ''}") · ` +
              `precio: ${indexToCol(priceIdx)} ("${headers[priceIdx] ?? ''}")` +
              (moqIdx >= 0 ? ` · MOQ: ${indexToCol(moqIdx)} ("${headers[moqIdx]}")` : ''))
  if (moqIdx < 0 && !args['sin-moq']) {
    console.log(`  Sin columna de MOQ: se conserva el que ya estuviera cargado. ` +
                `Si la lista lo trae con otro nombre, pasala con --moq-col=<cabecera|letra>.`)
  }
  console.log(`  Decimales: ${decimalComma ? 'coma' : 'punto'} ` +
              `(muestra cruda: ${priceSamples.slice(0, 4).join(' · ') || '—'})`)

  // ── --buscar: qué trae el archivo, más allá de lo que matchea mi catálogo ──
  // Que a MI catálogo le falte una categoría entera no prueba que el proveedor no la
  // venda: puede tenerla con otros códigos. Esto mira el archivo entero.
  if (args.buscar) {
    const re = new RegExp(args.buscar as string, 'i')
    const hits: { row: number; sku: string; texto: string; precio: string }[] = []
    for (let r = headerRow; r < sheet.rows.length; r++) {
      const row = sheet.rows[r]
      if (!row) continue
      const texto = row.map(c => c ?? '').join(' ')
      // Se prueba contra el código solo y contra la fila entera, para que "^JR233"
      // ancle en el SKU y no en el número de fila, que es la primera columna.
      if (re.test((row[skuIdx] ?? '').trim()) || re.test(texto)) {
        hits.push({
          row: r + 1,
          sku: (row[skuIdx] ?? '').trim(),
          texto: row.filter((c, i) => c && i !== skuIdx && i !== priceIdx).slice(0, 2).join(' · '),
          precio: (row[priceIdx] ?? '').trim(),
        })
      }
    }
    console.log(`\n"${args.buscar}" → ${hits.length} filas de ${sheet.rows.length - headerRow}`)
    for (const h of hits.slice(0, 15)) {
      console.log(`  ${h.sku.padEnd(14)} $${h.precio.padEnd(9)} ${h.texto}`)
    }
    if (hits.length > 15) console.log(`  … y ${hits.length - 15} más`)
    return
  }

  // ── Proveedor ──────────────────────────────────────────────────────────────
  const supplierName = (args.supplier as string)?.trim()
  if (!supplierName) throw new Error('Falta --supplier="<nombre del distribuidor>"')

  let supplier = await prisma.supplier.findUnique({ where: { name: supplierName } })
  if (!supplier && args.commit) {
    supplier = await prisma.supplier.create({ data: { name: supplierName, origen: 'india' } })
    console.log(`+ Proveedor creado: ${supplier.name} (origen=india)`)
  } else if (!supplier) {
    console.log(`  (simulacro) el proveedor "${supplierName}" no existe; se crearía con origen=india`)
  } else if (supplier.origen !== 'india') {
    throw new Error(`El proveedor "${supplier.name}" está cargado como origen='${supplier.origen}'. ` +
                    `Esta lista es EXW India — corregí el origen en /suppliers antes de importar.`)
  }

  // ── Catálogo: solo se rellenan SKU que ya existen ─────────────────────────
  const catalog = await prisma.product.findMany({
    where: { bajajCode: { not: null } },
    select: { id: true, bajajCode: true, nameEs: true, priceInr: true, isAssembly: true },
  })
  const byExact = new Map<string, (typeof catalog)[number]>()
  const byLoose = new Map<string, (typeof catalog)[number] | null>()  // null = ambiguo
  for (const p of catalog) {
    const k = normSku(p.bajajCode!)
    if (k) byExact.set(k, p)
    const l = looseSku(p.bajajCode!)
    // Si dos SKU distintos colapsan al mismo relajado, el match relajado no puede
    // decidir cuál es: se marca ambiguo y se descarta.
    if (l) byLoose.set(l, byLoose.has(l) ? null : p)
  }
  console.log(`Catálogo: ${catalog.length} productos con código Bajaj.`)

  // Doble SKU: Bajaj publica muchas piezas con dos números ("Decal Wheel Rh| JR233035|
  // JR233069") y cada proveedor elige uno. ScrapedPart guarda ese par en (sku, altSku):
  // si uno de los dos es el bajajCode de un producto mío, el otro es un alias legítimo
  // del mismo producto. Sin esto, media lista de tornillería parece no existir cuando
  // en realidad está publicada con el número que yo no guardé.
  const alias = new Map<string, (typeof catalog)[number] | null>()   // null = ambiguo
  const pares = await prisma.scrapedPart.findMany({
    where: { altSku: { not: null } },
    select: { sku: true, altSku: true },
  })
  const registrarAlias = (code: string, p: (typeof catalog)[number]) => {
    // Un código que ya es bajajCode de alguien se resuelve por match exacto, no por alias.
    if (!code || byExact.has(code)) return
    const previo = alias.get(code)
    alias.set(code, previo && previo.id !== p.id ? null : (previo === null ? null : p))
  }
  for (const { sku, altSku } of pares) {
    const a = normSku(sku), b = normSku(altSku!)
    const pa = byExact.get(a), pb = byExact.get(b)
    if (pa) registrarAlias(b, pa)
    if (pb) registrarAlias(a, pb)
  }
  const aliasUtiles = [...alias.values()].filter(Boolean).length
  if (aliasUtiles) console.log(`  ${aliasUtiles} códigos alternos conocidos (doble SKU de 99rpm).`)

  // ── Recorrido del archivo ─────────────────────────────────────────────────
  // Se guardan TODAS las apariciones de cada producto, no solo la que gana: un SKU
  // repetido con dos precios distintos es un dato del archivo que hay que poder ver,
  // no algo que el script deba resolver en silencio.
  interface Aparicion {
    row: number; skuArchivo: string; crudo: string; priceUsd: number | null
    moq: number | null; moqCrudo: string; loose: boolean; alterno: boolean
  }
  const apariciones = new Map<number, Aparicion[]>()
  let sinSku = 0, fueraDeCatalogo = 0, ambiguos = 0, alternosAmbiguos = 0
  const ambiguosDetalle: { row: number; sku: string }[] = []
  // Todos los códigos del archivo, míos o ajenos. Sirven después para explicar POR QUÉ
  // un SKU mío quedó sin precio: no es lo mismo "no lo venden" que "lo escriben distinto".
  const codigosArchivo = new Set<string>()
  const codigosLoose = new Map<string, string>()

  for (let r = headerRow; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    if (!row || row.every(c => c == null || c === '')) continue

    const skuRaw = (row[skuIdx] ?? '').trim()
    const crudo = (row[priceIdx] ?? '').trim()
    if (!skuRaw) { sinSku++; continue }
    codigosArchivo.add(normSku(skuRaw))
    if (!codigosLoose.has(looseSku(skuRaw))) codigosLoose.set(looseSku(skuRaw), skuRaw)

    let prod = byExact.get(normSku(skuRaw))
    let loose = false, alterno = false
    // Segunda pasada: el código alterno del par de 99rpm. No necesita --loose porque no
    // adivina nada — el par lo publica Bajaj, no lo inventa el script.
    if (!prod) {
      const al = alias.get(normSku(skuRaw))
      if (al) { prod = al; alterno = true }
      else if (al === null && alias.has(normSku(skuRaw))) alternosAmbiguos++
    }
    if (!prod && args.loose) {
      const hit = byLoose.get(looseSku(skuRaw))
      if (hit === null) { ambiguos++; ambiguosDetalle.push({ row: r + 1, sku: skuRaw }) }
      else if (hit) { prod = hit; loose = true }
    }
    // Lo que el distribuidor tiene y yo no: no me sirve, solo se cuenta.
    if (!prod) { fueraDeCatalogo++; continue }

    const moqCrudo = moqIdx >= 0 ? (row[moqIdx] ?? '').trim() : ''

    const lista = apariciones.get(prod.id) ?? []
    lista.push({
      row: r + 1, skuArchivo: skuRaw, crudo, priceUsd: parsePrice(crudo, decimalComma),
      moq: parseMoq(moqCrudo), moqCrudo, loose, alterno,
    })
    apariciones.set(prod.id, lista)
  }

  // ── Resolución: de las apariciones de cada SKU mío, cuál gana y qué anomalía deja ──
  const chosen = new Map<number, { sku: string; priceUsd: number; moq: number | null; row: number }>()
  const anom = {
    moqIlegible:       [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    moqDistinto:       [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    dupPrecioDistinto: [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    dupMismoPrecio:    [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    ilegible:          [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    noPositivo:        [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    subCentavo:        [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    relajado:          [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    porAlterno:        [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    dobleSkuIgual:     [] as { p: (typeof catalog)[number]; aps: Aparicion[] }[],
    dobleSkuDistinto:  [] as { p: (typeof catalog)[number]; aps: Aparicion[]; ratio: number; ganaRow: number; base: number | null }[],
    atipico:           [] as { p: (typeof catalog)[number]; precio: number; base: number; factor: number }[],
  }
  const byId = new Map(catalog.map(p => [p.id, p]))

  // La tasa se lee antes de resolver porque el precio base de 99rpm es el árbitro
  // cuando el proveedor lista la misma pieza con dos códigos a precios distintos.
  const cfg = await prisma.config.findUnique({ where: { key: 'inr_usd_rate' } })
  const inrUsd = parseFloat(cfg?.value ?? '')
  const hayTasa = Number.isFinite(inrUsd) && inrUsd > 0

  for (const [productId, aps] of apariciones) {
    const p = byId.get(productId)!
    const usables = aps.filter(a => a.priceUsd != null && a.priceUsd > 0 && round2(a.priceUsd) > 0)

    if (usables.length === 0) {
      // Ninguna aparición sirve: se clasifica por el motivo de la última.
      const ultima = aps[aps.length - 1]
      if (ultima.priceUsd == null) anom.ilegible.push({ p, aps })
      else if (ultima.priceUsd <= 0) anom.noPositivo.push({ p, aps })
      // priceUsd es Decimal(10,2): US$0,004 se guardaría como 0,00 y la pieza saldría
      // gratis en el costeo. Se descarta con nombre y apellido en vez de meter un cero.
      else anom.subCentavo.push({ p, aps })
      continue
    }

    // Cuando la pieza aparece con dos códigos a precios distintos, decide el precio base
    // de 99rpm: el que más se le parezca es el que corresponde a ESTA pieza. Se compara
    // en proporción y no en diferencia absoluta, porque el catálogo va de arandelas de
    // un centavo a tanques de $130 y una diferencia de $0,50 no significa lo mismo.
    // Sin priceInr no hay árbitro: ahí gana mi código antes que el del alias, y entre
    // iguales la última fila.
    const base = hayTasa && p.priceInr ? p.priceInr / inrUsd : null
    const porMiCodigo = usables.filter(a => !a.alterno && !a.loose)
    const gana = base != null && usables.length > 1
      ? usables.reduce((a, b) =>
          Math.abs(Math.log(a.priceUsd! / base)) <= Math.abs(Math.log(b.priceUsd! / base)) ? a : b)
      : (porMiCodigo.length ? porMiCodigo : usables).slice(-1)[0]
    // El MOQ sale de la MISMA fila que el precio: son el par (cuánto sale la pieza, de
    // a cuántas se puede pedir) y mezclarlos entre filas describiría una compra que el
    // proveedor no ofrece.
    chosen.set(productId, {
      sku: gana.skuArchivo, priceUsd: round2(gana.priceUsd!), moq: gana.moq, row: gana.row,
    })

    if (moqIdx >= 0) {
      // La celda tenía algo que no es una cantidad: se guarda null y se avisa, en vez de
      // asumir 1 (asumir 1 es exactamente el error que hace pedir menos del set).
      if (gana.moq == null && gana.moqCrudo) anom.moqIlegible.push({ p, aps: [gana] })
      const moqs = new Set(aps.map(a => a.moq).filter(m => m != null))
      if (moqs.size > 1) anom.moqDistinto.push({ p, aps })
    }

    if (aps.length > 1) {
      const codigos = new Set(aps.map(a => normSku(a.skuArchivo)))
      const precios = new Set(usables.map(a => round2(a.priceUsd!)))
      // Dos códigos distintos = el par de SKU de la misma pieza, no una fila duplicada.
      // Que coincidan en precio confirma el par; que no, es una discrepancia real del
      // proveedor (o un alias mal emparejado), y el ratio dice cuán grave es.
      if (codigos.size > 1) {
        if (precios.size > 1) {
          const vs = [...precios]
          anom.dobleSkuDistinto.push({
            p, aps, ratio: Math.max(...vs) / Math.min(...vs), ganaRow: gana.row, base,
          })
        } else anom.dobleSkuIgual.push({ p, aps })
      }
      else if (precios.size > 1) anom.dupPrecioDistinto.push({ p, aps })
      else anom.dupMismoPrecio.push({ p, aps })
    }
    if (gana.loose) anom.relajado.push({ p, aps: [gana] })
    if (gana.alterno) anom.porAlterno.push({ p, aps: [gana] })
  }

  // Precios que se despegan del base 99rpm por un factor grande. Es la red que caza
  // errores de unidad (precio por caja en vez de por pieza, decimal corrido, etc.).
  if (hayTasa) {
    for (const [productId, e] of chosen) {
      const inr = byId.get(productId)?.priceInr
      if (!inr) continue
      const base = inr / inrUsd
      const factor = e.priceUsd / base
      if (factor >= 3 || factor <= 1 / 3) {
        anom.atipico.push({ p: byId.get(productId)!, precio: e.priceUsd, base, factor })
      }
    }
    anom.atipico.sort((a, b) => Math.abs(Math.log(b.factor)) - Math.abs(Math.log(a.factor)))
  }

  const filas = sheet.rows.length - headerRow
  console.log(`\nArchivo: ${filas} filas de datos`)
  console.log(`  ${apariciones.size} SKU míos aparecen en la lista`)
  if (anom.porAlterno.length) {
    console.log(`    ${anom.porAlterno.length} de esos, con el OTRO código del par (doble SKU) — no se veían antes`)
  }
  if (alternosAmbiguos) console.log(`    ${alternosAmbiguos} códigos alternos ambiguos (apuntaban a 2 productos, descartados)`)
  console.log(`  ${fueraDeCatalogo} filas de SKU que no son míos (se ignoran)`)
  if (sinSku)     console.log(`  ${sinSku} filas sin SKU`)
  if (chosen.size) {
    const muestra = [...chosen.values()].slice(0, 5)
      .map(e => `${e.sku} $${e.priceUsd.toFixed(2)}${e.moq && e.moq > 1 ? ` ×${e.moq}` : ''}`)
    console.log(`  muestra: ${muestra.join(' · ')}`)
  }

  // ── MOQ ───────────────────────────────────────────────────────────────────
  // El que importa es el > 1: es el que convierte "cuesta US$0,40" en "la compra
  // mínima son US$20". El precio cargado sigue siendo por pieza.
  if (moqIdx >= 0) {
    const conMoq = [...chosen.values()].filter(e => e.moq != null)
    const conPiso = conMoq.filter(e => e.moq! > 1)
    console.log(`\nMOQ ("${headers[moqIdx]}"):`)
    console.log(`  ${conMoq.length} de ${chosen.size} SKU traen mínimo declarado`)
    if (conPiso.length) {
      const porMoq = new Map<number, number>()
      for (const e of conPiso) porMoq.set(e.moq!, (porMoq.get(e.moq!) ?? 0) + 1)
      const reparto = [...porMoq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([m, n]) => `mín. ${m}: ${n}`).join(' · ')
      console.log(`  ${conPiso.length} tienen mínimo > 1 — ${reparto}`)
      const caro = conPiso.map(e => ({ e, min: e.priceUsd * e.moq! }))
        .sort((a, b) => b.min - a.min).slice(0, 3)
        .map(x => `${x.e.sku} ×${x.e.moq} = $${x.min.toFixed(0)}`).join(' · ')
      console.log(`  compra mínima más cara: ${caro}`)
    } else {
      console.log(`  ninguno con mínimo: todo se puede pedir de a 1`)
    }
  }

  // ── Cobertura, mirado desde el catálogo ───────────────────────────────────
  const cubiertos = new Set(chosen.keys())
  const faltantes = catalog.filter(p => !cubiertos.has(p.id))
  const desbloqueados = catalog.filter(p => cubiertos.has(p.id) && p.priceInr == null).length
  const sinCodigo = await prisma.product.count({ where: { bajajCode: null } })
  const pct = (n: number) => ((n / catalog.length) * 100).toFixed(1)

  console.log(`\nCobertura del catálogo (${catalog.length} SKU con código Bajaj):`)
  console.log(`  ✔ ${cubiertos.size} con precio de ${supplierName} (${pct(cubiertos.size)}%)`)
  if (desbloqueados) {
    console.log(`    de esos, ${desbloqueados} no tenían precio base 99rpm — este distribuidor los desbloquea`)
  }
  console.log(`  ✘ ${faltantes.length} sin cubrir (${pct(faltantes.length)}%) — siguen con el precio base de 99rpm`)
  const faltantesSinBase = faltantes.filter(p => p.priceInr == null).length
  if (faltantesSinBase) {
    console.log(`    ${faltantesSinBase} de esos tampoco tienen precio base: no se pueden costear con nadie`)
  }
  if (sinCodigo) {
    console.log(`  (${sinCodigo} productos más no tienen código Bajaj: quedan fuera de cualquier cruce por SKU)`)
  }

  // ── Por qué faltó cada uno ────────────────────────────────────────────────
  // "No tiene precio" tiene causas muy distintas y cada una se arregla distinto:
  // que lo escriban con otro formato se resuelve con --loose, que sea un ensamble no
  // se resuelve nunca (nadie vende un conjunto por código), y que no esté es un dato
  // para pedirle al proveedor. Sin separarlas, los 293 parecen un problema solo.
  const porQue = {
    enArchivoSinPrecio: [] as typeof faltantes,             // sí lo cotizan, pero el precio no servía
    otroFormato:        [] as { p: (typeof catalog)[number]; enArchivo: string }[],
    contenido:          [] as { p: (typeof catalog)[number]; enArchivo: string }[],
    ensamble:           [] as typeof faltantes,             // conjunto mío, no una pieza comprable
    ausente:            [] as typeof faltantes,
  }
  // Índice por prefijo de 4 caracteres: comparar 293 × 45.781 códigos a lo bruto son
  // 13 millones de includes(); por prefijo son unos pocos cientos por SKU.
  const porPrefijo = new Map<string, string[]>()
  for (const c of codigosLoose.keys()) {
    const k = c.slice(0, 4)
    const l = porPrefijo.get(k); if (l) l.push(c); else porPrefijo.set(k, [c])
  }

  for (const p of faltantes) {
    const exacto = normSku(p.bajajCode!)
    const suelto = looseSku(p.bajajCode!)
    if (codigosArchivo.has(exacto)) { porQue.enArchivoSinPrecio.push(p); continue }
    const otro = codigosLoose.get(suelto)
    if (otro) { porQue.otroFormato.push({ p, enArchivo: otro }); continue }
    // Uno contiene al otro: típico de códigos con sufijo de color/variante.
    const candidato = (porPrefijo.get(suelto.slice(0, 4)) ?? [])
      .find(c => c !== suelto && (c.includes(suelto) || suelto.includes(c)))
    if (candidato) { porQue.contenido.push({ p, enArchivo: codigosLoose.get(candidato)! }); continue }
    if (p.isAssembly) { porQue.ensamble.push(p); continue }
    porQue.ausente.push(p)
  }

  console.log(`\nPor qué faltaron esos ${faltantes.length}:`)
  const causa = (n: number, txt: string) => { if (n) console.log(`  · ${n} ${txt}`) }
  causa(porQue.enArchivoSinPrecio.length, 'SÍ están en la lista, pero el precio no era usable (ver anomalías)')
  causa(porQue.otroFormato.length,        'están con el código escrito distinto → los recuperás con --loose')
  causa(porQue.contenido.length,          'hay un código parecido (uno contiene al otro): revisar a mano')
  causa(porQue.ensamble.length,           'son ensambles míos, no piezas: ningún proveedor los cotiza por código')
  causa(porQue.ausente.length,            'no aparecen en la lista de ninguna forma')

  // ── Reporte único, todo referido a MI catálogo ─────────────────────────────
  const anomTotal = anom.dobleSkuIgual.length + anom.dobleSkuDistinto.length +
                    anom.dupPrecioDistinto.length + anom.dupMismoPrecio.length +
                    anom.ilegible.length + anom.noPositivo.length + anom.subCentavo.length +
                    anom.relajado.length + anom.atipico.length +
                    anom.moqIlegible.length + anom.moqDistinto.length
  console.log(`\nAnomalías: ${anomTotal}`)
  const linea = (n: number, txt: string) => { if (n) console.log(`  · ${n} ${txt}`) }
  linea(anom.dobleSkuIgual.length,     'SKU míos listados con los DOS códigos, MISMO precio (confirma el par)')
  linea(anom.dobleSkuDistinto.length,  'SKU míos listados con los DOS códigos y PRECIOS DISTINTOS — gana el más cercano al base 99rpm')
  linea(anom.dupPrecioDistinto.length, 'SKU míos repetidos con el MISMO código y precios distintos')
  linea(anom.dupMismoPrecio.length,    'SKU míos repetidos con el mismo precio (inocuo)')
  linea(anom.ilegible.length,          'SKU míos con el precio vacío o ilegible')
  linea(anom.noPositivo.length,        'SKU míos con precio 0 o negativo')
  linea(anom.subCentavo.length,        'SKU míos con precio < US$0,01 (no entra en Decimal(10,2))')
  linea(anom.relajado.length,          'SKU míos matcheados por código escrito distinto (--loose)')
  linea(ambiguos,                      'filas cuyo match relajado era ambiguo (descartadas)')
  linea(anom.atipico.length,           'precios que se despegan 3x o más del base 99rpm')
  linea(anom.moqIlegible.length,       'SKU míos con el MOQ ilegible (se guarda sin MOQ, no se asume 1)')
  linea(anom.moqDistinto.length,       'SKU míos con DOS mínimos distintos entre sus filas — gana el de la fila del precio')

  const fmtAps = (aps: Aparicion[]) =>
    aps.map(a => `fila ${a.row}: "${a.skuArchivo}" = ${a.crudo || '(vacío)'}`).join(' | ')
  const seccion = (titulo: string, cuerpo: string[]) =>
    cuerpo.length ? `\n## ${titulo} (${cuerpo.length})\n${cuerpo.join('\n')}\n` : ''

  const reporteFile = `${file}.reporte.txt`
  writeReport(reporteFile,
    `# Reporte de importación — ${supplierName}\n` +
    `# archivo: ${basename(file)} · hoja "${sheet.name}" · ${new Date().toISOString()}\n` +
    `# ${cubiertos.size} de ${catalog.length} SKU del catálogo quedaron con precio (${pct(cubiertos.size)}%)\n` +
    `# ${fueraDeCatalogo} filas del archivo eran SKU ajenos: ignoradas a propósito.\n` +

    seccion('SIN PRECIO: NO APARECEN EN LA LISTA — código · nombre · base 99rpm (₹)',
      porQue.ausente.sort((a, b) => a.bajajCode!.localeCompare(b.bajajCode!))
        .map(p => `${p.bajajCode}\t${p.nameEs}\t${p.priceInr ?? ''}`)) +

    seccion('SIN PRECIO: EL PROVEEDOR LOS ESCRIBE DISTINTO — se recuperan con --loose',
      porQue.otroFormato.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\ten el archivo: "${d.enArchivo}"`)) +

    seccion('SIN PRECIO: HAY UN CÓDIGO PARECIDO — uno contiene al otro, revisar a mano',
      porQue.contenido.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\tparecido: "${d.enArchivo}"`)) +

    seccion('SIN PRECIO: SON ENSAMBLES MÍOS — nadie los cotiza por código',
      porQue.ensamble.map(p => `${p.bajajCode}\t${p.nameEs}\t${p.priceInr ?? ''}`)) +

    seccion('SIN PRECIO: ESTÁN EN LA LISTA PERO EL PRECIO NO SERVÍA — ver secciones de abajo',
      porQue.enArchivoSinPrecio.map(p => `${p.bajajCode}\t${p.nameEs}\t${p.priceInr ?? ''}`)) +

    seccion('DOS CÓDIGOS, PRECIOS DISTINTOS — se cargó «el más parecido al base 99rpm». Ordenado por discrepancia.',
      anom.dobleSkuDistinto.sort((a, b) => b.ratio - a.ratio).map(d =>
        `${d.p.bajajCode}\t${d.p.nameEs}\t×${d.ratio.toFixed(1)}\tbase $${d.base?.toFixed(2) ?? '—'}\t` +
        d.aps.map(a => `${a.row === d.ganaRow ? '«' : ''}"${a.skuArchivo}" = ${a.crudo}${a.row === d.ganaRow ? '»' : ''}`).join(' | '))) +

    seccion('DOS CÓDIGOS, MISMO PRECIO — el par queda confirmado, sin nada que decidir',
      anom.dobleSkuIgual.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('REPETIDOS CON EL MISMO CÓDIGO Y PRECIOS DISTINTOS — se cargó el ÚLTIMO. Revisar.',
      anom.dupPrecioDistinto.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('REPETIDOS CON EL MISMO PRECIO — sin consecuencia',
      anom.dupMismoPrecio.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('PRECIO VACÍO O ILEGIBLE — no se cargó nada',
      anom.ilegible.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('PRECIO 0 O NEGATIVO — no se cargó nada',
      anom.noPositivo.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('PRECIO MENOR A US$0,01 — no representable, no se cargó',
      anom.subCentavo.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('MATCHEADOS POR EL OTRO CÓDIGO DEL PAR (doble SKU de 99rpm) — mi código · nombre · el que usa el proveedor',
      anom.porAlterno.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('MATCHEADOS POR CÓDIGO ESCRITO DISTINTO (--loose) — verificar que sea la misma pieza',
      anom.relajado.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t${fmtAps(d.aps)}`)) +

    seccion('MATCH RELAJADO AMBIGUO — dos SKU míos colapsan al mismo código, descartadas',
      ambiguosDetalle.map(a => `fila ${a.row}\t${a.sku}`)) +

    seccion('PRECIOS ATÍPICOS VS BASE 99rpm — posible error de unidad o de decimal',
      anom.atipico.map(a => `${a.p.bajajCode}\t${a.p.nameEs}\t$${a.precio.toFixed(2)} vs base $${a.base.toFixed(2)}\t×${a.factor.toFixed(1)}`)) +

    // Lo que no se puede comprar de a una. Ordenado por compra mínima porque esa es la
    // plata que hay que poner sí o sí: 100 arandelas de un centavo no molestan, un mínimo
    // de 10 piezas de US$40 decide si la pieza entra en el embarque o no.
    seccion('CON MÍNIMO DE COMPRA (MOQ > 1) — código · nombre · precio pieza · mínimo · plata mínima',
      [...chosen.entries()]
        .filter(([, e]) => (e.moq ?? 1) > 1)
        .map(([id, e]) => ({ p: byId.get(id)!, e, min: e.priceUsd * e.moq! }))
        .sort((a, b) => b.min - a.min)
        .map(x => `${x.p.bajajCode}\t${x.p.nameEs}\t$${x.e.priceUsd.toFixed(2)}\t×${x.e.moq}\t$${x.min.toFixed(2)}`)) +

    seccion('MOQ ILEGIBLE — se guardó el precio sin MOQ (no se asume 1)',
      anom.moqIlegible.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t` +
        d.aps.map(a => `fila ${a.row}: "${a.moqCrudo}"`).join(' | '))) +

    seccion('MOQ DISTINTO ENTRE FILAS DEL MISMO SKU — se guardó el de la fila del precio elegido',
      anom.moqDistinto.map(d => `${d.p.bajajCode}\t${d.p.nameEs}\t` +
        d.aps.map(a => `fila ${a.row}: "${a.skuArchivo}" = ${a.crudo} ×${a.moq ?? '?'}`).join(' | '))),
  )
  console.log(`  → detalle completo, con nombres: ${reporteFile}`)

  if (chosen.size === 0) {
    console.log('\nNo hay nada para escribir.')
    return
  }

  // ── Comparación contra el precio base (99rpm en ₹) ─────────────────────────
  // Es el costo de producto contra costo de producto: los dos son EXW India, así que
  // el flete que se suma encima es el mismo y no cambia el orden.
  if (hayTasa) {
    const deltas: number[] = []
    let masBarato = 0, masCaro = 0
    for (const [productId, e] of chosen) {
      const inr = byId.get(productId)?.priceInr
      if (!inr) continue
      const base = inr / inrUsd
      deltas.push((e.priceUsd - base) / base)
      if (e.priceUsd < base) masBarato++; else masCaro++
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b)
      const mediana = deltas[Math.floor(deltas.length / 2)]
      console.log(`\nVs. precio base 99rpm (${deltas.length} SKU comparables, tasa ₹${inrUsd}/USD):`)
      console.log(`  ${masBarato} más barato · ${masCaro} más caro · mediana ${(mediana * 100).toFixed(1)}%`)
    }
  }

  // ── Escritura ──────────────────────────────────────────────────────────────
  if (!args.commit || !supplier) {
    console.log(`\nSIMULACRO — no se escribió nada. Agregá --commit para aplicar ${chosen.size} precios.`)
    return
  }

  const previos = await prisma.supplierPrice.findMany({
    where: { supplierId: supplier.id },
    select: { productId: true },
  })
  const yaTenia = new Set(previos.map(p => p.productId))
  const altas = [...chosen.keys()].filter(id => !yaTenia.has(id)).length

  const entries = [...chosen.entries()]
  let escritos = 0
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK)
    const values = slice.map((_, j) =>
      `($${j * 4 + 1}::int, $${j * 4 + 2}::int, $${j * 4 + 3}::numeric, $${j * 4 + 4}::int, false, NOW())`).join(', ')
    const params = slice.flatMap(([productId, e]) => [productId, supplier!.id, e.priceUsd, e.moq])
    // El MOQ se conserva si esta corrida no lo trae (COALESCE): una lista sin la columna,
    // o una celda vacía, es "no lo declara", no "cambió a 1". Lo contrario borraría en
    // silencio un dato que costó conseguir cada vez que se re-importa una lista parcial.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SupplierPrice" ("productId", "supplierId", "priceUsd", "moq", "isLanded", "updatedAt")
       VALUES ${values}
       ON CONFLICT ("productId", "supplierId")
       DO UPDATE SET "priceUsd" = EXCLUDED."priceUsd",
                     "moq" = COALESCE(EXCLUDED."moq", "SupplierPrice"."moq"),
                     "isLanded" = EXCLUDED."isLanded",
                     "updatedAt" = NOW()`,
      ...params,
    )
    escritos += slice.length
    process.stdout.write(`\r  escribiendo… ${escritos}/${entries.length}`)
  }

  console.log(`\n\n✓ ${escritos} precios en ${supplier.name} — ${altas} altas, ${escritos - altas} actualizaciones.`)
  const conMoqEscrito = entries.filter(([, e]) => e.moq != null).length
  if (conMoqEscrito) {
    const enSet = entries.filter(([, e]) => (e.moq ?? 1) > 1).length
    console.log(`  ${conMoqEscrito} con MOQ (${enSet} en set > 1).`)
  }
  // Total real del proveedor: si ya se había importado otra lista antes, la cobertura
  // acumulada es mayor que la de esta corrida.
  const total = await prisma.supplierPrice.count({ where: { supplierId: supplier.id } })
  if (total !== escritos) {
    console.log(`  Cobertura acumulada de ${supplier.name}: ${total}/${catalog.length} SKU (${pct(total)}%), contando importaciones previas.`)
  }
  console.log(`  Todos con isLanded=false (costo EXW: calcLanded les suma Shoppre + seguro + marítimo).`)
  console.log(`  Para verlos aplicados, activá "${supplier.name}" como proveedor en /suppliers.`)
}

main()
  .catch((e) => { console.error(`\n✗ ${e instanceof Error ? e.message : e}`); process.exit(1) })
  .finally(() => prisma.$disconnect())
