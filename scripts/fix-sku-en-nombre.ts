/**
 * Rescata las piezas cuyo código Bajaj quedó ATRAPADO EN EL NOMBRE.
 *
 * El scraper decidía qué token del nombre era el código con /^[A-Z0-9]{5,10}$/ — sensible a
 * la caja. 99rpm publica algunos códigos capitalizados ("Damper - Rubber | Dh101414"), así
 * que ese token no se reconocía, se quedaba dentro del nombre y la pieza nacía con
 * bajajCode = null. Dos consecuencias, las dos silenciosas:
 *
 *   1. Sin código no hay cruce por SKU: la pieza no aparece en la lista de ningún
 *      proveedor aunque el proveedor la venda. `import-supplier-prices` solo rellena SKU
 *      que ya están en el catálogo, así que la fila del Excel se descartaba como ajena.
 *   2. `materialize-catalog` deduplica las piezas POR CÓDIGO. Sin código crea un Product
 *      por cada aparición, así que la misma pieza quedó repetida una vez por cada ensamble
 *      que la usa (hasta 11 copias), cada una con su propio peso y su propio precio.
 *
 * El scraper ya está arreglado (scripts/scrape-99rpm.ts), pero eso solo cubre los scrapes
 * futuros: este script repara lo que ya está en la base. Hace tres cosas:
 *
 *   · ScrapedPart: saca el código del nombre y lo pone en `sku` (y en `altSku` si hay dos).
 *   · Product: le pone el `bajajCode` y le limpia el nombre.
 *   · Fusiona las copias en un solo Product por código, moviéndole todo lo que colgaba de
 *     las otras (enlaces de ensamble, líneas de embarque, ítems de pedido, precios de
 *     proveedor) antes de borrarlas.
 *
 * Quién sobrevive a la fusión NO es el id más chico: es la copia que tiene algo que perder.
 * Manda la que está usada en un pedido o en un embarque, después la que tiene medidas
 * cargadas (que es trabajo manual y caro de rehacer), y recién ahí la más vieja. Si dos
 * copias distintas están usadas en documentos distintos, no fusiona: avisa y sigue, porque
 * elegir cuál sobrevive ahí es una decisión comercial, no de datos.
 *
 * Uso:
 *   pnpm exec tsx scripts/fix-sku-en-nombre.ts           # SIMULACRO (no escribe)
 *   pnpm exec tsx scripts/fix-sku-en-nombre.ts --apply   # escribe
 */
import { PrismaClient } from '@prisma/client'

try { process.loadEnvFile() } catch {}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
})
const APPLY = process.argv.includes('--apply')

const norm = (s: string) => s.trim().toUpperCase()
/** Misma regla que el scraper ya arreglado: caja libre, dígito obligatorio. */
const esCodigo = (s: string) => /^[A-Za-z0-9]{5,10}$/.test(s.trim()) && /\d/.test(s)

/** "Damper - Rubber | Dh101414" → { nombre: "Damper - Rubber", codigos: ["DH101414"] } */
function partir(texto: string): { nombre: string; codigos: string[] } {
  const toks = texto.split('|').map(t => t.trim()).filter(Boolean)
  const codigos = toks.filter(esCodigo).map(norm)
  const resto = toks.filter(t => !esCodigo(t)).join(' | ').replace(/\s+/g, ' ').trim()
  // Un nombre que era SOLO el código no se puede vaciar: se deja como estaba.
  return { nombre: resto || texto.trim(), codigos }
}

const joinModels = (s: Set<string>) => [...s].filter(Boolean).sort().join(', ')

async function main() {
  console.log(APPLY ? '── APPLY (escribe) ──\n' : '── SIMULACRO (no escribe) ──\n')

  // ───────────────────────────────────────────────────────────────────────────
  // 1) ScrapedPart: el código vuelve a su columna
  // ───────────────────────────────────────────────────────────────────────────
  const partes = await prisma.scrapedPart.findMany({
    where: { sku: '' },
    select: { id: true, name: true },
  })
  const arreglosSp = partes
    .map(p => ({ id: p.id, ...partir(p.name), original: p.name }))
    .filter(p => p.codigos.length > 0)

  console.log(`ScrapedPart sin sku: ${partes.length} · recuperables: ${arreglosSp.length}`)
  if (APPLY) {
    for (const a of arreglosSp) {
      await prisma.scrapedPart.update({
        where: { id: a.id },
        data: { sku: a.codigos[0], altSku: a.codigos[1] ?? null, name: a.nombre },
      })
    }
    console.log(`  ✓ ${arreglosSp.length} actualizadas`)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2) Product: agrupar las copias por el código escondido
  // ───────────────────────────────────────────────────────────────────────────
  const sinCodigo = await prisma.product.findMany({
    where: { bajajCode: null, isAssembly: false },
    select: {
      id: true, nameEs: true, nameEn: true, compatibleModels: true, priceInr: true,
      weightGrams: true, dimL: true, dimA: true, dimH: true, stock: true,
      price: true, margin: true, landedCostUsd: true, priceLocked: true, discontinuedAt: true,
      _count: { select: { components: true, pedidoItems: true, envioLineas: true } },
    },
  })

  type Prod = (typeof sinCodigo)[number]
  const grupos = new Map<string, Prod[]>()
  for (const p of sinCodigo) {
    const { codigos } = partir(p.nameEs)
    if (!codigos.length) continue
    const l = grupos.get(codigos[0]); if (l) l.push(p); else grupos.set(codigos[0], [p])
  }
  const afectados = [...grupos.values()].flat().length
  console.log(`\nProductos con el código en el nombre: ${afectados} → ${grupos.size} códigos reales`)

  // Un código escondido podría ya existir como bajajCode de otro producto (curado a mano).
  // Ese gana siempre: es el que tiene la historia.
  const yaExisten = await prisma.product.findMany({
    where: { bajajCode: { in: [...grupos.keys()] } },
    select: { id: true, bajajCode: true, nameEs: true },
  })
  const existentePorCodigo = new Map(yaExisten.map(p => [norm(p.bajajCode!), p]))
  if (yaExisten.length) console.log(`  ${yaExisten.length} de esos códigos YA existen en el catálogo: se fusiona contra ellos`)

  // ───────────────────────────────────────────────────────────────────────────
  // 3) Fusión, código por código
  // ───────────────────────────────────────────────────────────────────────────
  const usado = (p: Prod) => p._count.pedidoItems + p._count.envioLineas
  const medido = (p: Prod) => p.weightGrams != null || p.dimL != null

  let fusionados = 0, borrados = 0, conflictos = 0, conHijos = 0
  const detalle: string[] = []

  for (const [codigo, copias] of [...grupos.entries()].sort()) {
    // Una pieza no debería tener hijos; si los tiene no es una copia suelta y no se toca.
    const padres = copias.filter(p => p._count.components > 0)
    if (padres.length) {
      conHijos++
      console.log(`  ⚠ ${codigo}: ${padres.map(p => '#' + p.id).join(',')} tienen componentes propios → se saltea el código entero`)
      continue
    }

    const enUso = copias.filter(p => usado(p) > 0)
    if (enUso.length > 1) {
      conflictos++
      console.log(`  ⚠ ${codigo}: ${enUso.map(p => `#${p.id} (${usado(p)} uso/s)`).join(' y ')} están en documentos distintos → NO se fusiona, resolvelo a mano`)
      continue
    }

    // Orden de preferencia: usada > medida > más vieja.
    const ordenadas = [...copias].sort((a, b) =>
      (usado(b) - usado(a)) || (Number(medido(b)) - Number(medido(a))) || (a.id - b.id))
    const previo = existentePorCodigo.get(codigo)
    const survId = previo ? previo.id : ordenadas[0].id
    const perdedoras = ordenadas.filter(p => p.id !== survId)

    const { nombre } = partir(ordenadas[0].nameEs)
    const razon = previo ? 'ya existía' : usado(ordenadas[0]) ? 'está en uso' : medido(ordenadas[0]) ? 'tiene medidas' : 'la más vieja'
    detalle.push(`  ${codigo}\t«${nombre}»\tsobrevive #${survId} (${razon})` +
      (perdedoras.length ? `\tabsorbe ${perdedoras.map(p => '#' + p.id).join(',')}` : '\tsin duplicados'))

    if (!APPLY) { fusionados++; borrados += perdedoras.length; continue }

    // ── Datos que se rescatan de las copias antes de borrarlas ───────────────
    // Peso y medidas son trabajo manual: si la que sobrevive no los tiene y otra sí, viajan.
    const surv = ordenadas.find(p => p.id === survId)
    const conMedida = ordenadas.find(medido)
    const modelos = new Set<string>()
    for (const p of copias) for (const m of (p.compatibleModels ?? '').split(',')) if (m.trim()) modelos.add(m.trim())

    const data: Record<string, unknown> = { bajajCode: codigo }
    if (!previo) {
      // El producto rescatado: nombre limpio y los modelos de todas las apariciones.
      data.nameEs = nombre
      data.nameEn = partir(ordenadas[0].nameEn ?? '').nombre || null
      data.compatibleModels = joinModels(modelos) || null
      if (surv && !medido(surv) && conMedida) {
        data.weightGrams = conMedida.weightGrams
        data.dimL = conMedida.dimL; data.dimA = conMedida.dimA; data.dimH = conMedida.dimH
        data.price = conMedida.price; data.margin = conMedida.margin
        data.landedCostUsd = conMedida.landedCostUsd; data.priceLocked = conMedida.priceLocked
      }
      const stock = copias.reduce((s, p) => s + p.stock, 0)
      if (stock !== (surv?.stock ?? 0)) data.stock = stock
      // Descontinuado es un hecho de fábrica: si CUALQUIER copia lo tenía, vale para todas.
      const fechas = copias.map(p => p.discontinuedAt).filter(Boolean) as Date[]
      if (fechas.length) data.discontinuedAt = new Date(Math.min(...fechas.map(d => d.getTime())))
      const inr = copias.map(p => p.priceInr).find(v => v != null)
      if (surv?.priceInr == null && inr != null) data.priceInr = inr
    }
    await prisma.product.update({ where: { id: survId }, data })

    // ── Mover todo lo que cuelga de las perdedoras ───────────────────────────
    for (const perd of perdedoras) {
      // Enlaces de ensamble. El (padre, hijo, grupo) es único: si el sobreviviente ya está
      // en ese mismo grupo del mismo padre, el enlace duplicado se borra en vez de moverse.
      const enlaces = await prisma.productComponent.findMany({
        where: { childId: perd.id }, select: { id: true, parentId: true, groupName: true },
      })
      for (const e of enlaces) {
        const choca = await prisma.productComponent.findUnique({
          where: { parentId_childId_groupName: { parentId: e.parentId, childId: survId, groupName: e.groupName } },
          select: { id: true },
        })
        if (choca) await prisma.productComponent.delete({ where: { id: e.id } })
        else await prisma.productComponent.update({ where: { id: e.id }, data: { childId: survId } })
      }

      // Líneas de embarque marítimo: (envio, producto) es único → se suman las cantidades,
      // que es lo que la línea significa (cuántas piezas de esa van en la caja).
      const lineas = await prisma.envioLinea.findMany({
        where: { productId: perd.id }, select: { id: true, envioId: true, quantity: true },
      })
      for (const l of lineas) {
        const choca = await prisma.envioLinea.findUnique({
          where: { envioId_productId: { envioId: l.envioId, productId: survId } },
          select: { id: true, quantity: true },
        })
        if (choca) {
          await prisma.envioLinea.update({ where: { id: choca.id }, data: { quantity: choca.quantity + l.quantity } })
          await prisma.envioLinea.delete({ where: { id: l.id } })
        } else {
          await prisma.envioLinea.update({ where: { id: l.id }, data: { productId: survId } })
        }
      }

      // Ítems de pedido: un choque acá sería la misma pieza dos veces en el mismo pedido,
      // con su propio precio congelado. No se toca — lo resuelve una persona.
      const items = await prisma.pedidoItem.findMany({
        where: { productId: perd.id }, select: { id: true, pedidoId: true },
      })
      for (const it of items) {
        const choca = await prisma.pedidoItem.findUnique({
          where: { pedidoId_productId: { pedidoId: it.pedidoId, productId: survId } },
          select: { id: true },
        })
        if (choca) {
          console.log(`  ⚠ ${codigo}: el pedido ${it.pedidoId} ya tiene al sobreviviente → ítem #${it.id} queda como está`)
        } else {
          await prisma.pedidoItem.update({ where: { id: it.id }, data: { productId: survId } })
        }
      }

      // Precios de proveedor: (producto, proveedor) es único. El del sobreviviente manda.
      const precios = await prisma.supplierPrice.findMany({
        where: { productId: perd.id }, select: { id: true, supplierId: true },
      })
      for (const sp of precios) {
        const choca = await prisma.supplierPrice.findUnique({
          where: { productId_supplierId: { productId: survId, supplierId: sp.supplierId } },
          select: { id: true },
        })
        if (choca) await prisma.supplierPrice.delete({ where: { id: sp.id } })
        else await prisma.supplierPrice.update({ where: { id: sp.id }, data: { productId: survId } })
      }

      await prisma.scrapedPart.updateMany({ where: { matchedProductId: perd.id }, data: { matchedProductId: survId } })

      // Recién ahora: si quedó algo colgando, el borrado falla y es una señal, no un daño.
      const quedan = await prisma.pedidoItem.count({ where: { productId: perd.id } })
      if (quedan) { console.log(`  ⚠ ${codigo}: #${perd.id} sigue en ${quedan} pedido(s) → no se borra`); continue }
      await prisma.product.delete({ where: { id: perd.id } })
      borrados++
    }
    fusionados++
  }

  console.log(`\n${detalle.join('\n')}`)
  console.log(`\nResumen: ${fusionados} códigos rescatados · ${borrados} productos duplicados ${APPLY ? 'borrados' : 'a borrar'}`)
  if (conflictos) console.log(`  ${conflictos} códigos salteados por uso en documentos distintos`)
  if (conHijos) console.log(`  ${conHijos} códigos salteados por tener componentes propios`)

  if (!APPLY) {
    console.log(`\nSIMULACRO — no se escribió nada. Corré con --apply para aplicar.`)
    return
  }
  const restan = await prisma.product.count({ where: { bajajCode: null, isAssembly: false } })
  console.log(`\nPiezas sin código que quedan: ${restan} (las que 99rpm publica sin número)`)
  console.log(`Ahora reimportá la lista del proveedor para que estos SKU tomen precio:`)
  console.log(`  npx tsx scripts/import-supplier-prices.ts --file=<lista.xlsx> --supplier="Oemship" --commit`)
}

main()
  .catch((e) => { console.error(`\n✗ ${e instanceof Error ? e.message : e}`); process.exit(1) })
  .finally(() => prisma.$disconnect())
