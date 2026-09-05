/**
 * Actualiza el precio en ₹ de 99rpm y la marca de descontinuado sobre el catálogo.
 *
 * Lee data/scrape/products.json (lo que dejó `pnpm scrape:99rpm`) y escribe SOLO eso:
 *
 *   priceInr · discontinuedAt · y lo que se derive del costo (price/margin/landedCostUsd)
 *
 * NO pasa por seed-scraped ni materialize-catalog a propósito. Esos dos son el camino para
 * INCORPORAR el catálogo — crean productos, rehacen los subgrupos, enlazan componentes,
 * suben imágenes a S3. Acá no queremos nada de eso: una corrida de precios no puede crear
 * piezas que no elegiste, ni reordenar despieces, ni tocar el peso y las dimensiones que
 * costó tanto cargar. Lo único que cambia es lo que 99rpm es autoridad para decir: cuánto
 * sale la pieza y si todavía se fabrica.
 *
 * Corre EN SECO por defecto. `--apply` es lo que escribe.
 *
 * Uso:
 *   pnpm prices:99rpm                      # informe, no escribe nada
 *   pnpm prices:99rpm --apply              # aplica
 *   pnpm prices:99rpm --file=service-parts.json
 *   pnpm prices:99rpm --max-delta=200      # tope de variación permitida, en % (default 300)
 *   pnpm prices:99rpm --apply --no-reprice # actualiza ₹ sin recalcular precios de venta
 *   pnpm prices:99rpm --apply --skip=DH111015,JR131882
 *
 * `--skip` es la salida de escape para cuando el ₹ del catálogo se refiere a otra UNIDAD que
 * el SKU de 99rpm (un pack contra una pieza suelta): ahí el "cambio de precio" no es tal, y
 * aplicarlo repreciaría mal. El informe las detecta comparando el nombre del scrape contra
 * `nameEn` — nunca contra `nameEs`, que es el nombre comercial en español que puso una
 * persona ("Kit bujías" para una bujía que la moto lleva de a dos) y que difiere casi
 * siempre sin que eso signifique nada.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../lib/db'
import { reprice } from '../lib/reprice'
import { getConfig } from '@/lib/config-db'
import { margenPorDefecto } from '@/lib/config'
try { process.loadEnvFile() } catch {}

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase()

interface PartJson { sku?: string; altSku?: string; priceInr?: number; discontinued?: boolean; name?: string }

/** Lo que el scrape afirma de un SKU, ya consolidado entre todas sus apariciones. */
interface Afirmacion {
  sku: string
  /** Nombre según 99rpm. Se informa al lado del nombre del catálogo: cuando no hablan de
   *  lo mismo ("Oil Filter" vs "Filtro aceite (x1)"), el precio tampoco. */
  nombre: string
  priceInr: number
  /** Descontinuado se acumula por OR: la misma pieza está en varios ensambles y 99rpm no
   *  siempre la rotula en todos. Que la fábrica la discontinuó es un hecho de la pieza. */
  discontinued: boolean
  /** Apariciones con precios distintos: 99rpm cotiza la misma pieza a distinto precio en
   *  ensambles distintos. Se toma el MENOR y se avisa — es el que vas a poder pedir. */
  precios: Set<number>
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const noReprice = args.includes('--no-reprice')
  const file = args.find(a => a.startsWith('--file='))?.split('=')[1] ?? 'products.json'
  const maxDelta = Number(args.find(a => a.startsWith('--max-delta='))?.split('=')[1] ?? 300)
  const skip = new Set(
    (args.find(a => a.startsWith('--skip='))?.split('=')[1] ?? '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  )

  const raw = JSON.parse(await readFile(path.join('data', 'scrape', file), 'utf8')) as any[]
  console.log(`Fuente: data/scrape/${file} · ${raw.length} ensambles`)
  console.log(apply ? 'MODO: aplicar\n' : 'MODO: en seco (no escribe nada) — agregá --apply para aplicar\n')

  // ── 1. Consolidar lo que dice el scrape, por SKU ──────────────────────────
  const porSku = new Map<string, Afirmacion>()
  let sinSku = 0, sinPrecio = 0
  for (const prod of raw) {
    for (const p of (prod.parts ?? []) as PartJson[]) {
      const sku = norm(p.sku)
      if (!sku) { sinSku++; continue }
      // Un precio de 0 (o negativo) es una lectura fallida, no una pieza gratis: pisar un
      // precio bueno con eso sería romper el catálogo con datos rotos.
      const precio = Math.round(Number(p.priceInr ?? 0))
      const previo = porSku.get(sku)
      const nombre = (p.name ?? '').trim()
      if (!Number.isFinite(precio) || precio <= 0) {
        sinPrecio++
        if (previo) previo.discontinued ||= !!p.discontinued
        else porSku.set(sku, { sku, nombre, priceInr: 0, discontinued: !!p.discontinued, precios: new Set() })
        continue
      }
      if (previo) {
        previo.precios.add(precio)
        previo.priceInr = previo.priceInr > 0 ? Math.min(previo.priceInr, precio) : precio
        previo.discontinued ||= !!p.discontinued
        if (!previo.nombre) previo.nombre = nombre
      } else {
        porSku.set(sku, { sku, nombre, priceInr: precio, discontinued: !!p.discontinued, precios: new Set([precio]) })
      }
    }
  }
  const conPrecio = [...porSku.values()].filter(a => a.priceInr > 0)
  const discrepantes = conPrecio.filter(a => a.precios.size > 1)
  console.log(`SKU en el scrape: ${porSku.size} (${conPrecio.length} con precio · ${sinSku} piezas sin código · ${sinPrecio} apariciones sin precio)`)
  if (discrepantes.length) console.log(`  ${discrepantes.length} con precios distintos entre ensambles — se toma el menor`)
  console.log(`  ${[...porSku.values()].filter(a => a.discontinued).length} rotulados como descontinuados`)

  // ── 2. Cruzar contra el catálogo, por código propio y por alterno ─────────
  const codigos = [...porSku.keys()]
  const productos = await db.product.findMany({
    where: { bajajCode: { not: null } },
    select: {
      id: true, bajajCode: true, nameEs: true, nameEn: true, priceInr: true, discontinuedAt: true,
      weightGrams: true, dimL: true, dimA: true, dimH: true,
      margin: true, price: true, priceLocked: true,
    },
  })
  // El catálogo guarda UNO de los dos números del par; el scrape puede traer el otro.
  const pares = await db.scrapedPart.findMany({
    where: { AND: [{ altSku: { not: null } }, { OR: [{ sku: { in: codigos } }, { altSku: { in: codigos } }] }] },
    select: { sku: true, altSku: true },
  })
  const alterno = new Map<string, string>()
  for (const p of pares) {
    const a = norm(p.sku), b = norm(p.altSku)
    if (a && b && a !== b) { alterno.set(a, b); alterno.set(b, a) }
  }
  const afirmacionDe = (code: string) => porSku.get(code) ?? porSku.get(alterno.get(code) ?? '')

  const cfg = await getConfig()
  const defaultMargin = margenPorDefecto(cfg)

  // ── 3. Decidir qué cambia ─────────────────────────────────────────────────
  interface Cambio {
    id: number; code: string; nameEs: string; nameEn: string | null; nombre99: string
    deInr: number | null; aInr: number
    dePrice: number; aPrice?: number
    priceLocked: boolean
    nls: boolean
  }
  const cambiosPrecio: Cambio[] = []
  const soloNls: { id: number; code: string; nameEs: string }[] = []
  const sospechosos: Cambio[] = []
  let sinCambio = 0, sinDato = 0, salteados = 0

  for (const p of productos) {
    const code = norm(p.bajajCode)
    if (skip.has(code)) { salteados++; continue }
    const af = afirmacionDe(code)
    if (!af) { sinDato++; continue }

    const marcarNls = af.discontinued && p.discontinuedAt == null
    const cambiaPrecio = af.priceInr > 0 && af.priceInr !== p.priceInr

    if (!cambiaPrecio) {
      if (marcarNls) soloNls.push({ id: p.id, code, nameEs: p.nameEs })
      else sinCambio++
      continue
    }

    const c: Cambio = {
      id: p.id, code, nameEs: p.nameEs, nameEn: p.nameEn, nombre99: af.nombre,
      deInr: p.priceInr, aInr: af.priceInr,
      dePrice: Number(p.price), priceLocked: !!p.priceLocked, nls: marcarNls,
    }

    // Variación absurda = casi siempre un SKU que 99rpm reasignó a otra pieza, no un
    // aumento. Se separa en vez de aplicarse: revisarlas a mano cuesta mucho menos que
    // descubrir dentro de tres meses que vendiste a un precio inventado.
    if (p.priceInr != null && p.priceInr > 0) {
      const delta = Math.abs((af.priceInr - p.priceInr) / p.priceInr) * 100
      if (delta > maxDelta) { sospechosos.push(c); continue }
    }

    if (!noReprice) {
      const r = reprice(
        { ...p, priceInr: af.priceInr, price: Number(p.price), priceLocked: !!p.priceLocked },
        cfg, defaultMargin,
      )
      if (r.data.price != null) c.aPrice = r.data.price
    }
    cambiosPrecio.push(c)
  }

  // ── 4. Informe ────────────────────────────────────────────────────────────
  const suben = cambiosPrecio.filter(c => c.deInr != null && c.aInr > c.deInr).length
  const bajan = cambiosPrecio.filter(c => c.deInr != null && c.aInr < c.deInr).length
  const nuevos = cambiosPrecio.filter(c => c.deInr == null).length

  console.log(`\nCatálogo: ${productos.length} piezas con código · ${sinDato} no aparecen en este scrape${salteados ? ` · ${salteados} salteadas por --skip` : ''}`)
  console.log(`\nPrecios a cambiar: ${cambiosPrecio.length}  (${suben} suben · ${bajan} bajan · ${nuevos} sin ₹ hasta ahora)`)
  console.log(`  sin cambio: ${sinCambio}`)
  console.log(`  descontinuadas a marcar: ${cambiosPrecio.filter(c => c.nls).length + soloNls.length}`)
  if (!noReprice) {
    const reprecio = cambiosPrecio.filter(c => c.aPrice != null && c.aPrice !== c.dePrice).length
    const fijos = cambiosPrecio.filter(c => c.priceLocked).length
    console.log(`  precios de venta que se mueven: ${reprecio} (${fijos} con precio fijo: no se tocan, se reajusta el margen)`)
  }

  // El riesgo real es que el ₹ del catálogo se refiera a OTRA unidad que el SKU de 99rpm
  // (un pack contra una pieza suelta). Para detectarlo hay que comparar contra `nameEn`, no
  // contra `nameEs`: el español es el nombre comercial que puso una persona ("Kit bujías"
  // para una bujía que la moto lleva de a dos), mientras que `nameEn` conserva el nombre
  // con el que la pieza entró del scrape. Comparar contra el español marcaba como
  // sospechosa cada pieza traducida — nueve falsas alarmas sobre nueve.
  const clave = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const curadas = cambiosPrecio.filter(c => c.nombre99 && clave(c.nameEn ?? c.nameEs) !== clave(c.nombre99))
  if (curadas.length) {
    console.log(`\n⚠ ${curadas.length} con nombre distinto al de 99rpm — revisá que sean la MISMA unidad antes de aplicar:`)
    for (const c of curadas.slice(0, 20)) {
      const pct = c.deInr && c.deInr > 0 ? `${((c.aInr - c.deInr) / c.deInr * 100).toFixed(0)}%` : 'nuevo'
      console.log(`  ${c.code.padEnd(11)} ₹${String(c.deInr).padStart(6)} → ₹${String(c.aInr).padStart(6)}  ${pct.padStart(5)}   ${(c.nameEn ?? c.nameEs).slice(0, 34).padEnd(34)} ← ${c.nombre99.slice(0, 34)}`)
    }
    if (curadas.length > 20) console.log(`  … y ${curadas.length - 20} más`)
    console.log(`  para excluirlas:  --skip=${curadas.slice(0, 8).map(c => c.code).join(',')}${curadas.length > 8 ? ',…' : ''}`)
  }

  const conDelta = cambiosPrecio
    .filter(c => c.deInr != null && c.deInr > 0)
    .sort((a, b) => Math.abs((b.aInr - b.deInr!) / b.deInr!) - Math.abs((a.aInr - a.deInr!) / a.deInr!))
  if (conDelta.length) {
    console.log('\nMayores variaciones (catálogo ← 99rpm: si los nombres no hablan de lo mismo, el precio tampoco):')
    for (const c of conDelta.slice(0, 20)) {
      const pct = ((c.aInr - c.deInr!) / c.deInr!) * 100
      const venta = c.aPrice != null && c.aPrice !== c.dePrice ? ` · venta $${c.dePrice.toFixed(2)}→$${c.aPrice.toFixed(2)}` : ''
      const fijo = c.priceLocked ? ' 🔒' : ''
      console.log(`  ${c.code.padEnd(11)} ₹${String(c.deInr).padStart(6)} → ₹${String(c.aInr).padStart(6)}  ${(pct > 0 ? '+' : '') + pct.toFixed(0) + '%'}${venta}${fijo}`)
      console.log(`              ${c.nameEs.slice(0, 42).padEnd(42)} ← ${c.nombre99.slice(0, 42)}`)
    }
  }

  if (sospechosos.length) {
    console.log(`\n⚠ ${sospechosos.length} descartadas por variar más de ${maxDelta}% (NO se tocan; revisalas a mano):`)
    for (const c of sospechosos.slice(0, 15)) {
      console.log(`  ${c.code.padEnd(11)} ₹${String(c.deInr).padStart(6)} → ₹${String(c.aInr).padStart(6)}  ${c.nameEs.slice(0, 40)}`)
    }
    if (sospechosos.length > 15) console.log(`  … y ${sospechosos.length - 15} más`)
  }

  if (!apply) {
    console.log('\nNada escrito. Volvé a correr con --apply para aplicar.')
    return
  }

  // ── 5. Aplicar ────────────────────────────────────────────────────────────
  let escritos = 0
  for (const c of cambiosPrecio) {
    const p = productos.find(x => x.id === c.id)!
    const data: Record<string, unknown> = { priceInr: c.aInr }
    if (c.nls) data.discontinuedAt = new Date()
    if (!noReprice) {
      const r = reprice(
        { ...p, priceInr: c.aInr, price: Number(p.price), priceLocked: !!p.priceLocked },
        cfg, defaultMargin,
      )
      Object.assign(data, r.data)
    }
    await db.product.update({ where: { id: c.id }, data })
    // Cada 25 y no cada 250: son ~600 viajes a una base remota, varios minutos, y con dos
    // líneas de progreso en toda la corrida no hay forma de distinguir "avanzando" de
    // "colgado". Lo primero que uno hace ante esa duda es matarlo por las dudas.
    if (++escritos % 25 === 0) console.log(`  ${escritos}/${cambiosPrecio.length}…`)
  }

  // Las que solo cambian de estado: una sola sentencia, sin recalcular nada.
  if (soloNls.length) {
    await db.product.updateMany({
      where: { id: { in: soloNls.map(x => x.id) } },
      data: { discontinuedAt: new Date() },
    })
  }

  console.log(`\n✓ ${escritos} piezas con precio actualizado · ${soloNls.length} marcadas descontinuadas sin tocar su precio`)
  if (sospechosos.length) console.log(`  ${sospechosos.length} quedaron sin tocar por superar el ${maxDelta}% de variación`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
