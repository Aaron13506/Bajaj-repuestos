import { db } from './db'

// ─────────────────────────────────────────────────────────────────────────────
// Doble SKU
//
// Bajaj publica muchas piezas con dos números ("Decal Wheel Rh| JR233035| JR233069") y
// cada proveedor elige uno. Mi catálogo guarda UNO en Product.bajajCode; el par completo
// vive en ScrapedPart (sku, altSku), que es de donde salió el catálogo.
//
// Sin esto, buscar por el código que usa el proveedor no encuentra nada: la pieza está,
// pero registrada con el otro número. Es exactamente el momento en que uno tiene la
// cotización del proveedor en la mano y la tipea — el peor momento para un "sin resultados",
// porque la conclusión natural es "no la tengo en el catálogo" y se carga duplicada.
//
// El import de precios hace este mismo cruce (scripts/import-supplier-prices.ts) pero con
// su propio cliente: allá es un mapa completo en memoria de las 45k filas del Excel, acá
// son consultas puntuales de lo que se está tipeando. Misma regla, dos escalas.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toUpperCase()

/**
 * Código tipeado → todos sus equivalentes, él mismo incluido.
 *
 * Conserva de QUIÉN salió cada equivalente, que es lo que hace falta cuando se procesa una
 * lista pegada y hay que decir cuáles códigos no existen: con la unión aplanada se sabe
 * que faltó algo, pero no qué línea de lo que pegaste estaba mal.
 */
export async function equivalenciasDe(codigos: string[]): Promise<Map<string, string[]>> {
  const base = [...new Set(codigos.map(norm).filter(Boolean))]
  const out = new Map(base.map(c => [c, [c]]))
  if (base.length === 0) return out

  const pares = await db.scrapedPart.findMany({
    where: { OR: [{ sku: { in: base } }, { altSku: { in: base } }] },
    select: { sku: true, altSku: true },
  })

  for (const p of pares) {
    const a = norm(p.sku)
    const b = p.altSku ? norm(p.altSku) : null
    if (!b || a === b) continue
    // El par se ancla por los dos lados: pegaste uno cualquiera de los dos números.
    for (const [mio, otro] of [[a, b], [b, a]] as const) {
      const eq = out.get(mio)
      if (eq && !eq.includes(otro)) eq.push(otro)
    }
  }
  return out
}

/**
 * Todos los códigos equivalentes a los que se tipearon: los propios más el otro lado de
 * cada par. Devuelve también los originales, así el llamador consulta una sola vez.
 */
export async function conAlternos(codigos: string[]): Promise<string[]> {
  const m = await equivalenciasDe(codigos)
  return [...new Set([...m.values()].flat())]
}

/**
 * productId → el OTRO código del par, para los productos pedidos. Es lo que se muestra
 * al lado del código propio: "el proveedor lo lista como …". Solo devuelve entrada para
 * las piezas que efectivamente tienen dos números.
 */
export async function alternosDe(productIds: number[]): Promise<Map<number, string>> {
  if (productIds.length === 0) return new Map()

  const productos = await db.product.findMany({
    where: { id: { in: productIds }, bajajCode: { not: null } },
    select: { id: true, bajajCode: true },
  })
  if (productos.length === 0) return new Map()

  const codigos = productos.map(p => norm(p.bajajCode!))
  const pares = await db.scrapedPart.findMany({
    where: { AND: [{ altSku: { not: null } }, { OR: [{ sku: { in: codigos } }, { altSku: { in: codigos } }] }] },
    select: { sku: true, altSku: true },
  })

  // código propio → el otro del par. Si un código aparece en dos pares distintos el
  // alterno es ambiguo y no se muestra ninguno: media pantalla afirmando un código
  // equivocado es peor que no mostrarlo.
  const porCodigo = new Map<string, string | null>()
  const anotar = (mio: string, otro: string) => {
    if (mio === otro) return
    const previo = porCodigo.get(mio)
    porCodigo.set(mio, previo === undefined ? otro : previo === otro ? otro : null)
  }
  for (const p of pares) {
    const a = norm(p.sku), b = norm(p.altSku!)
    anotar(a, b)
    anotar(b, a)
  }

  const out = new Map<number, string>()
  for (const p of productos) {
    const alt = porCodigo.get(norm(p.bajajCode!))
    if (alt) out.set(p.id, alt)
  }
  return out
}

/**
 * Productos cuyo código ALTERNO matchea el término tipeado. Complementa la búsqueda
 * normal (nombre / bajajCode), no la reemplaza: acá solo se resuelven los que no se
 * encontraron por su propio número.
 */
export async function buscarPorAlterno(term: string, excluir: Set<number>, take: number): Promise<number[]> {
  const q = term.trim()
  if (q.length < 2 || take <= 0) return []

  // El par se busca por los DOS lados: el término puede ser el sku o el altSku de la
  // fila, y en cualquier caso el que me interesa es el otro.
  const pares = await db.scrapedPart.findMany({
    where: {
      AND: [
        { altSku: { not: null } },
        { OR: [{ sku: { contains: q, mode: 'insensitive' } }, { altSku: { contains: q, mode: 'insensitive' } }] },
      ],
    },
    select: { sku: true, altSku: true },
    take: 60,
  })
  if (pares.length === 0) return []

  const codigos = [...new Set(pares.flatMap(p => [norm(p.sku), norm(p.altSku!)]))]
  const rows = await db.product.findMany({
    where: { bajajCode: { in: codigos } },
    select: { id: true },
    take: take + excluir.size,
  })
  return rows.map(r => r.id).filter(id => !excluir.has(id)).slice(0, take)
}
