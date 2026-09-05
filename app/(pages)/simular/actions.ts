'use server'

import { db } from '@/lib/db'
import { equivalenciasDe } from '@/lib/alt-sku'
import { parseListaSkus } from '@/lib/lista-skus'
import { expandCostPieces, lookupDeConjuntos, type ProductCost } from '@/lib/envio-build'
import type { BundlePiece } from '@/lib/bundle'

// ─────────────────────────────────────────────────────────────────────────────
// Lista pegada → piezas del catálogo, con los precios que cada proveedor cotiza.
//
// Devuelve los precios de TODOS los proveedores para esas piezas de una sola vez, y no
// los de uno elegido, porque la pantalla que la llama compara a todos contra todos y
// además deja mover las tarifas en vivo. Con un viaje por proveedor cada tecla del campo
// "envío a USA" volvería al servidor; con este payload —una fila por par (pieza,
// proveedor) que exista— el recálculo entero pasa a ser local.
//
// El cruce por SKU alterno es obligatorio acá: la lista sale de la cotización DEL
// PROVEEDOR, y cada proveedor usa uno de los dos números que Bajaj publica. Sin el cruce,
// la pieza está en el catálogo pero la lista dice "no encontrada", y la conclusión natural
// —cargarla de nuevo— duplica el catálogo justo antes de comparar precios sobre él.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaResuelta {
  /** El código tal como venía en la lista: es lo que hay que mostrar si algo no cierra. */
  sku: string
  /** El código con el que quedó registrada en el catálogo, si es el otro del par. */
  skuCatalogo: string | null
  productId: number
  nameEs: string
  qty: number
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  /** Bajaj dejó de fabricarla: no la consigue ningún proveedor, cotice o no cotice. */
  discontinuada: boolean
  stock: number
}

export interface PrecioProveedor {
  supplierId: number
  productId: number
  priceUsd: number
  isLanded: boolean
  moq: number | null
}

export interface ListaResuelta {
  ok: boolean
  lineas: LineaResuelta[]
  precios: PrecioProveedor[]
  /** Códigos que no existen en el catálogo, ni por su número ni por su alterno. */
  noEncontrados: string[]
  sinCodigo: { nombre: string; qty: number }[]
  errores: string[]
  avisos: string[]
}

// El estado inicial vive en el cliente: un archivo 'use server' solo puede exportar
// funciones async, y una constante acá rompe el build.

const norm = (s: string) => s.trim().toUpperCase()

export async function resolverLista(_prev: ListaResuelta, formData: FormData): Promise<ListaResuelta> {
  const parsed = parseListaSkus(String(formData.get('lista') ?? ''))
  const out: ListaResuelta = {
    ok: false,
    lineas: [],
    precios: [],
    noEncontrados: [],
    sinCodigo: parsed.sinCodigo,
    errores: [...parsed.errores],
    avisos: [...parsed.avisos],
  }
  if (parsed.lineas.length === 0) return out

  // Los dos números de cada línea entran al cruce: el documento puede traer el par completo.
  const tipeados = parsed.lineas.flatMap(l => [l.sku, ...(l.skuAlt ? [l.skuAlt] : [])])
  const equivalencias = await equivalenciasDe(tipeados)
  const todos = [...new Set([...equivalencias.values()].flat())]

  // Comparación exacta pero insensible a mayúsculas: los códigos llegan de PDFs y fotos,
  // y un fallo acá se lee como "no la tengo en el catálogo".
  const productos = await db.product.findMany({
    where: { OR: todos.map(c => ({ bajajCode: { equals: c, mode: 'insensitive' as const } })) },
    select: {
      id: true, bajajCode: true, nameEs: true, isAssembly: true, stock: true,
      weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true, discontinuedAt: true,
    },
  })
  const porCodigo = new Map(productos.filter(p => p.bajajCode).map(p => [norm(p.bajajCode!), p]))

  for (const linea of parsed.lineas) {
    // Se prueba el código tipeado, después su par, y recién ahí se da por perdido.
    const candidatos = [
      ...(equivalencias.get(norm(linea.sku)) ?? [norm(linea.sku)]),
      ...(linea.skuAlt ? equivalencias.get(norm(linea.skuAlt)) ?? [norm(linea.skuAlt)] : []),
    ]
    const p = candidatos.map(c => porCodigo.get(c)).find(Boolean)

    if (!p) { out.noEncontrados.push(linea.sku); continue }
    if (p.isAssembly) {
      // Un ensamble no es una pieza que se compre: es el grupo que las contiene. Sumarlo
      // al embarque contaría dos veces todo lo que ya está adentro.
      out.avisos.push(`«${linea.sku}» es un ensamble (${p.nameEs}), no una pieza suelta: no entra.`)
      continue
    }
    if (p.discontinuedAt) {
      out.avisos.push(`«${linea.sku}» (${p.nameEs}) está descontinuada de fábrica: no la consigue ningún proveedor.`)
    }

    out.lineas.push({
      sku: linea.sku,
      skuCatalogo: norm(p.bajajCode!) === norm(linea.sku) ? null : p.bajajCode,
      productId: p.id,
      nameEs: p.nameEs,
      qty: linea.qty,
      weightGrams: p.weightGrams,
      dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
      priceInr: p.priceInr,
      discontinuada: p.discontinuedAt != null,
      stock: p.stock,
    })
  }

  out.precios = await preciosDe(out.lineas.map(l => l.productId))

  out.ok = out.lineas.length > 0
  if (!out.ok && out.errores.length === 0) {
    out.errores.push('Ninguno de los códigos de la lista existe en el catálogo.')
  }
  return out
}

// Los precios de TODOS los proveedores para esas piezas, en una sola consulta. Es la mitad
// cara del payload y la que hace que la pantalla recalcule sin volver al servidor.
async function preciosDe(productIds: number[]): Promise<PrecioProveedor[]> {
  if (productIds.length === 0) return []
  const precios = await db.supplierPrice.findMany({
    where: { productId: { in: productIds } },
    select: { supplierId: true, productId: true, priceUsd: true, isLanded: true, moq: true },
  })
  return precios.map(p => ({
    supplierId: p.supplierId,
    productId: p.productId,
    priceUsd: parseFloat(p.priceUsd.toString()),
    isLanded: p.isLanded,
    moq: p.moq,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Un presupuesto YA CREADO → la misma canasta, para comparar con qué proveedor conviene
// comprarlo.
//
// Es la pregunta que faltaba: la comparación arrancaba siempre de una lista pegada a mano,
// así que para preguntar "este presupuesto, ¿me conviene comprárselo a Garuda o traerlo
// como siempre por 99rpm?" había que transcribir sus 20 códigos a un textarea — y una
// transcripción es una segunda fuente del mismo dato, que es exactamente lo que esta
// pantalla existe para no tener.
//
// Los CONJUNTOS se expanden a sus piezas reales (expandCostPieces), porque un proveedor no
// cotiza "el kit de embrague": cotiza cada pieza. Costear el ensamble entero sobreestima
// —agrega TODAS sus piezas, no las que el cliente eligió— y además no habría precio de
// proveedor que aplicarle.
//
// Devuelve la MISMA forma que la lista pegada para que río abajo no haya dos caminos: el
// costeo, los avisos y la tabla no distinguen de dónde salió la canasta.
// ─────────────────────────────────────────────────────────────────────────────
export async function cargarPedido(pedidoId: number): Promise<ListaResuelta> {
  const out: ListaResuelta = {
    ok: false, lineas: [], precios: [], noEncontrados: [], sinCodigo: [], errores: [], avisos: [],
  }

  const pedido = await db.pedido.findUnique({
    where: { id: pedidoId },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true, nameEs: true, bajajCode: true, weightGrams: true,
              dimL: true, dimA: true, dimH: true, priceInr: true,
              stock: true, discontinuedAt: true,
            },
          },
        },
      },
    },
  })
  if (!pedido) {
    out.errores.push('Ese presupuesto ya no existe.')
    return out
  }
  if (pedido.items.length === 0) {
    out.errores.push(`«${pedido.clientName}» no tiene ítems cargados.`)
    return out
  }

  const lookup = await lookupDeConjuntos(pedido.items.map(it => it.bundleItems as BundlePiece[] | null))
  const piezas = pedido.items.flatMap(it =>
    expandCostPieces(it.product as ProductCost, it.quantity, it.bundleItems as BundlePiece[] | null, lookup),
  )

  // Un mismo SKU puede venir de dos líneas (suelto en una, dentro de un conjunto en otra).
  // Se suman: la caja lleva una cantidad sola, y separarlas partiría el MOQ en dos pedidos
  // que cada uno queda por debajo del mínimo.
  const porProducto = new Map<number, LineaResuelta>()
  for (const p of piezas) {
    if (p.productId == null) {
      // La pieza del conjunto no cruzó contra el catálogo: sin producto no hay precio de
      // proveedor ni medidas, así que entraría con costo 0 y flete 0. Se nombra en vez de
      // sumarla callada.
      out.sinCodigo.push({ nombre: p.name, qty: p.quantity })
      continue
    }
    const ya = porProducto.get(p.productId)
    if (ya) { ya.qty += p.quantity; continue }
    const cat = pedido.items.find(it => it.product.id === p.productId)?.product
    porProducto.set(p.productId, {
      sku: p.sku ?? `#${p.productId}`,
      skuCatalogo: null,
      productId: p.productId,
      nameEs: p.name,
      qty: p.quantity,
      weightGrams: p.weightGrams,
      dimL: p.dimL, dimA: p.dimA, dimH: p.dimH,
      priceInr: p.priceInr,
      // Solo se sabe de las piezas que son ítem del presupuesto; las que salen de un
      // conjunto se resuelven por lookup y ese select no trae el estado de fábrica.
      discontinuada: cat?.discontinuedAt != null,
      stock: cat?.stock ?? 0,
    })
  }

  out.lineas = [...porProducto.values()]
  for (const l of out.lineas) {
    if (l.discontinuada) {
      out.avisos.push(`«${l.sku}» (${l.nameEs}) está descontinuada de fábrica: no la consigue ningún proveedor.`)
    }
  }
  if (out.sinCodigo.length > 0) {
    out.avisos.push(
      `${out.sinCodigo.length} pieza${out.sinCodigo.length === 1 ? '' : 's'} de un conjunto no cruzó contra el ` +
      'catálogo: no entran a la comparación, así que el total les falta.',
    )
  }

  out.precios = await preciosDe(out.lineas.map(l => l.productId))
  out.ok = out.lineas.length > 0
  if (!out.ok && out.errores.length === 0) {
    out.errores.push('Ninguna pieza de ese presupuesto se pudo resolver contra el catálogo.')
  }
  return out
}
