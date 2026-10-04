'use server'

import { db } from '@/lib/db'
import { toModelIds } from '@/lib/modelo'
import { lookupDeConjuntos, expandCostPieces, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'
import { calcLanded, type ConfigMap } from '@/lib/calc'
import { toConfigMap, margenPorDefecto } from '@/lib/config'
import type { RefLinea } from '@/lib/linea-pedido'

// Componentes de UN ensamble, cargados on-demand cuando se selecciona (evita traer
// los ~14k componentes de todo el catálogo al abrir el armador de presupuestos).
export async function getAssemblyComponents(ensambleId: number) {
  const comps = await db.ensambleComponente.findMany({
    where: { ensambleId },
    include: {
      product: {
        select: {
          id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true,
          compatibleModels: true, discontinuedAt: true,
        },
      },
    },
    orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  })
  return comps.map(c => ({
    id: c.id,
    groupName: c.groupName,
    quantity: c.quantity,
    product: {
      id: c.product.id,
      nameEs: c.product.nameEs,
      bajajCode: c.product.bajajCode,
      price: parseFloat(c.product.price.toString()),
      imageUrl: c.product.imageUrl,
      models: toModelIds(c.product.compatibleModels),
      // Bajaj no la fabrica más. Acá pesa incluso más que en un embarque: el negocio es por
      // encargo, así que cotizarla es prometerle a un cliente algo que no se va a poder
      // comprar — y con seña cobrada.
      descontinuada: c.product.discontinuedAt != null,
    },
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Costeo en vivo del carrito.
//
// Un presupuesto es un documento COMERCIAL, y lo comercial viaja por AIRE: un cliente que
// encarga una pieza no puede esperar el barco. Por eso acá se costea con la cadena aérea
// (Shoppre + seguro + tramo Miami→CCS) y no con la marítima — el m³ y el FOB son del otro
// carril, el de la mercancía propia, que vive en el embarque.
//
// El precio de origen es SIEMPRE el de 99rpm (`priceInr`): es la base con la que se fija el
// precio de venta. Con qué proveedor se compra de verdad cada línea se decide después, al
// armar la caja (ver /envios y /simular).
// ─────────────────────────────────────────────────────────────────────────────

export interface CarritoLineaInput extends RefLinea {
  quantity: number
  salePrice: number
  bundleItems?: BundlePiece[] | null
}

export interface CostoLinea extends RefLinea {
  /** Cantidad con la que se costeó: todos los totales de la línea ya la incluyen. */
  quantity: number
  landedUsd: number
  /** Peso cobrable de la línea (kg). Es lo que factura el aéreo. */
  weightKg: number
  /** Precio de venta de la LÍNEA entera, aplicando el margen sobre el landed. */
  sugeridoUsd: number | null
  /** El mismo sugerido por unidad (o por conjunto) — la unidad en la que se cotiza. */
  sugeridoUnitUsd: number | null
  sinPeso: number
  totalPiezas: number
}

export interface CostoCarrito {
  lineas: CostoLinea[]
  landedUsd: number
  weightKg: number
  costoOrigenUsd: number
  fleteUsd: number
  sinPeso: number
  /** Siempre 99rpm: el aéreo no tiene otro distribuidor posible. */
  proveedor: string | null
}

export async function costearCarrito(lineas: CarritoLineaInput[]): Promise<CostoCarrito> {
  const vacio: CostoCarrito = {
    lineas: [], landedUsd: 0, weightKg: 0, costoOrigenUsd: 0, fleteUsd: 0, sinPeso: 0, proveedor: '99rpm',
  }
  if (lineas.length === 0) return vacio

  const [configRows, productos, lookup] = await Promise.all([
    db.config.findMany(),
    db.product.findMany({
      where: { id: { in: lineas.flatMap(l => (l.productId != null ? [l.productId] : [])) } },
      select: {
        id: true, nameEs: true, bajajCode: true, weightGrams: true,
        dimL: true, dimA: true, dimH: true, priceInr: true,
      },
    }),
    lookupDeConjuntos(lineas.map(l => l.bundleItems ?? null)),
  ])

  const cfg = toConfigMap(configRows)
  const porId = new Map<number, ProductCost>(productos.map(p => [p.id, p]))
  const defaultMargin = margenPorDefecto(cfg)

  // Margen de cada pieza que puede aparecer (las de conjuntos incluidas), para sugerir precio.
  const piezasIds = new Set<number>(lineas.flatMap(l => (l.productId != null ? [l.productId] : [])))
  for (const l of lineas) {
    for (const bp of l.bundleItems ?? []) {
      const r = lookup(bp.bajajCode, bp.nameEs)
      if (r) piezasIds.add(r.id)
    }
  }
  const margenes = await db.product.findMany({
    where: { id: { in: [...piezasIds] } },
    select: { id: true, margin: true },
  })
  const margenPorId = new Map(margenes.map(m => [m.id, m.margin]))

  const out: CostoLinea[] = []
  for (const l of lineas) {
    // Una pieza suelta se costea por sí misma; un conjunto, solo por el snapshot de sus piezas
    // (el ensamble no tiene peso, medidas ni precio). Una línea que no resuelve a nada se
    // omite: el carrito pudo quedar con una pieza que se borró mientras tanto.
    const product = l.productId != null ? porId.get(l.productId) ?? null : null
    const esConjunto = l.ensambleId != null
    if (esConjunto ? !(l.bundleItems && l.bundleItems.length > 0) : !product) continue

    const linea: CostoLinea = {
      productId: l.productId, ensambleId: l.ensambleId, quantity: l.quantity, landedUsd: 0, weightKg: 0,
      sugeridoUsd: 0, sugeridoUnitUsd: null, sinPeso: 0, totalPiezas: 0,
    }

    // Los conjuntos se costean por las piezas que llevan, no por el ensamble entero
    // (que agrega TODAS sus piezas y sobreestima).
    for (const pieza of expandCostPieces(product, l.quantity, l.bundleItems ?? null, lookup)) {
      const b = calcLanded({
        priceInr:      pieza.priceInr,
        weightGrams:   pieza.weightGrams,
        dimL:          pieza.dimL,
        dimA:          pieza.dimA,
        dimH:          pieza.dimH,
        margin:        null,
      }, cfg, 'aereo')

      linea.totalPiezas++
      linea.weightKg += ((pieza.weightGrams ?? 0) / 1000) * pieza.quantity
      // Sin peso el aéreo no se puede costear: la pieza queda marcada, no estimada.
      if (b == null) { linea.sinPeso++; continue }

      linea.landedUsd += b.landedCostUsd * pieza.quantity
      const margen = (pieza.productId != null ? margenPorId.get(pieza.productId) : null) ?? defaultMargin
      if (linea.sugeridoUsd != null && Number.isFinite(margen) && margen < 1) {
        linea.sugeridoUsd += (b.landedCostUsd / (1 - margen)) * pieza.quantity
      } else {
        linea.sugeridoUsd = null
      }
    }

    // El carrito cotiza por unidad (o por conjunto); el costeo agrega la línea entera.
    linea.sugeridoUnitUsd = linea.sugeridoUsd != null && l.quantity > 0
      ? linea.sugeridoUsd / l.quantity
      : null
    out.push(linea)
  }

  const sum = (f: (l: CostoLinea) => number) => out.reduce((s, l) => s + f(l), 0)
  return {
    lineas: out,
    landedUsd: sum(l => l.landedUsd),
    weightKg: sum(l => l.weightKg),
    costoOrigenUsd: 0,
    fleteUsd: 0,
    sinPeso: sum(l => l.sinPeso),
    proveedor: '99rpm',
  }
}

// Ensambles que CONTIENEN una pieza con este SKU. El filtro del armador corre sobre los
// headers ya cargados (nombre y código del ensamble), así que el SKU de una pieza —que es
// con lo que llega el cliente: tiene el código de la pieza, no el del ensamble— nunca
// puede matchear ahí. Solo se busca por bajajCode y no por nombre de pieza: "sensor"
// devolvería medio catálogo, mientras que un SKU identifica una pieza puntual.
export async function searchAssembliesByPiece(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const comps = await db.ensambleComponente.findMany({
    where: { product: { bajajCode: { contains: q, mode: 'insensitive' } } },
    select: { ensambleId: true, product: { select: { nameEs: true, bajajCode: true } } },
    // Una pieza genérica (un tornillo) vive en cientos de ensambles; el tope evita
    // traer esa cola entera para una lista que igual no se puede recorrer a mano.
    take: 400,
    orderBy: { id: 'asc' },
  })
  // Un ensamble puede repetir la misma pieza en varios subgrupos: nos quedamos con
  // la primera aparición, que es la que se muestra como motivo del match.
  const porEnsamble = new Map<number, { ensambleId: number; pieceName: string; pieceCode: string }>()
  for (const c of comps) {
    if (porEnsamble.has(c.ensambleId)) continue
    porEnsamble.set(c.ensambleId, {
      ensambleId: c.ensambleId,
      pieceName: c.product.nameEs,
      pieceCode: c.product.bajajCode ?? '',
    })
  }
  return Array.from(porEnsamble.values())
}

// Búsqueda de piezas sueltas por nombre o código (server-side), en vez de mandar los
// 5.5k productos al navegador.
export async function searchProducts(term: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const rows = await db.product.findMany({
    where: {
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true, nameEs: true, bajajCode: true, price: true, imageUrl: true,
      compatibleModels: true, discontinuedAt: true,
    },
    take: 12,
    orderBy: { nameEs: 'asc' },
  })
  return rows.map(p => ({
    id: p.id,
    nameEs: p.nameEs,
    bajajCode: p.bajajCode,
    price: parseFloat(p.price.toString()),
    imageUrl: p.imageUrl,
    models: toModelIds(p.compatibleModels),
    // Sigue apareciendo en la búsqueda, tachada y sin poder agregarse: si la estás
    // buscando es porque el cliente la pidió, y lo que necesitás saber es que ya no se
    // fabrica — no que "no hay resultados".
    descontinuada: p.discontinuedAt != null,
  }))
}
