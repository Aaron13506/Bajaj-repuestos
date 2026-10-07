import type { BundlePiece } from './bundle'

// Qué piezas del catálogo mueve una línea de pedido cuando entra (o sale) del stock.
//
// Una pieza suelta mueve su producto. Un CONJUNTO mueve las piezas de su snapshot: el
// ensamble no es un producto y no tiene stock, pero lo que llega en la caja son sus piezas,
// y son esas las que después se venden. Durante un tiempo el conjunto no acreditaba nada
// ("el snapshot no alcanza para saber a qué fila corresponde cada pieza") y el stock propio
// —que se arma casi entero con conjuntos— desaparecía al llegar: salía de "en camino" y no
// entraba al depósito.
//
// El snapshot guarda el código de Bajaj, y el código identifica la pieza: no hay dos
// productos con el mismo `bajajCode`. Sin código se cae al nombre, pero solo si ese nombre es
// de UNA pieza. Lo que no resuelve así (código que no existe, código o nombre repetido) no se
// adivina: se devuelve en `faltan` y quien llama decide — entregar no puede seguir,
// porque sumaría el conjunto a medias sin avisar.
//
// Puro, sin base: lo prueba `pnpm check:costeo`. El resolver que consulta el catálogo es
// resolverDePiezas, en lib/inventario.ts.

export interface LineaStock {
  productId: number | null
  quantity: number
  bundleItems: BundlePiece[] | null
}

export interface PiezaStock {
  productId: number
  unidades: number
}

export type ResolverPieza = (p: BundlePiece) => number | null

// Las piezas que mueve UNA línea, sumadas por producto (una misma pieza puede estar en dos
// subgrupos del ensamble). `faltan` son las del snapshot que no se pudieron resolver.
export function piezasDeLinea(linea: LineaStock, resolver: ResolverPieza): { piezas: PiezaStock[]; faltan: BundlePiece[] } {
  if (!linea.bundleItems || linea.bundleItems.length === 0) {
    return {
      piezas: linea.productId != null ? [{ productId: linea.productId, unidades: linea.quantity }] : [],
      faltan: [],
    }
  }
  const porProducto = new Map<number, number>()
  const faltan: BundlePiece[] = []
  for (const bp of linea.bundleItems) {
    const id = resolver(bp)
    if (id == null) { faltan.push(bp); continue }
    porProducto.set(id, (porProducto.get(id) ?? 0) + bp.quantity * linea.quantity)
  }
  return { piezas: [...porProducto].map(([productId, unidades]) => ({ productId, unidades })), faltan }
}

// Un código o nombre que aparece en más de un producto
// queda sin resolver: elegir uno sería sumar stock a una pieza que quizá no es.
export function construirResolver(productos: { id: number; bajajCode: string | null; nameEs: string }[]): ResolverPieza {
  const unico = <K>(pares: [K, number][]) => {
    const m = new Map<K, number | null>()
    for (const [k, id] of pares) m.set(k, m.has(k) && m.get(k) !== id ? null : id)
    return m
  }
  const porCodigo = unico(productos.flatMap(p => (p.bajajCode ? [[p.bajajCode, p.id] as [string, number]] : [])))
  const porNombre = unico(productos.map(p => [p.nameEs, p.id] as [string, number]))
  return bp => (bp.bajajCode ? porCodigo.get(bp.bajajCode) ?? null : porNombre.get(bp.nameEs) ?? null)
}

// Cómo nombrar las piezas que no se pudieron resolver, para el mensaje de error.
export function listarFaltantes(faltan: BundlePiece[], max = 3): string {
  const nombres = [...new Set(faltan.map(f => f.bajajCode ?? f.nameEs))]
  return nombres.slice(0, max).join(', ') + (nombres.length > max ? '…' : '')
}
