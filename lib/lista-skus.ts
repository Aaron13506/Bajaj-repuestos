// ─────────────────────────────────────────────────────────────────────────────
// Una lista de compra pegada: SKU y cantidad, nada más.
//
// El precio NO viaja en la lista y es a propósito. Lo que se está comparando es
// justamente a quién comprarle, y ese precio ya está cargado por par (producto,
// proveedor) en SupplierPrice: si además viniera pegado en el texto, habría dos fuentes
// para el mismo número y la comparación terminaría midiendo cuál de las dos se tipeó
// mejor. La lista dice QUÉ y CUÁNTO; el cuánto cuesta lo pone la base.
//
// Se tolera texto plano además de JSON porque el origen real es una foto, un PDF o un
// mensaje: si el JSON no parsea, la lista igual se puede leer línea por línea, y un
// "no pude" a esta altura obliga a tipear treinta códigos a mano.
//
// Nada de esto toca la base ni el costeo: son funciones puras, para poder chequearlas
// y para que el mismo parseo corra en el navegador y en el server action.
// ─────────────────────────────────────────────────────────────────────────────

import { extractJson } from './json-ia'

export interface SkuQty {
  /** El código tal cual se pegó. No se normaliza: la búsqueda ya es case-insensitive. */
  sku: string
  /** El otro número del par, cuando el documento trae los dos. Ver lib/alt-sku.ts. */
  skuAlt: string | null
  qty: number
  /** Lo que decía el documento al lado del código. Solo para auditar el match. */
  nombre: string | null
}

export interface ListaParseada {
  lineas: SkuQty[]
  /** Filas que la IA no pudo codificar: quedan a la vista para buscarlas a mano. */
  sinCodigo: { nombre: string; qty: number }[]
  errores: string[]
  avisos: string[]
}

const vacia = (): ListaParseada => ({ lineas: [], sinCodigo: [], errores: [], avisos: [] })

function toStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// Cantidad: entero ≥ 1. Un 0 o un negativo es un error de lectura, no una cantidad, y
// dejarlo pasar borra la línea del embarque sin decirlo.
function toQty(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.-]/g, '')) : Number(v)
  if (!Number.isFinite(n)) return null
  const q = Math.round(n)
  return q >= 1 ? q : null
}

function primero(o: Record<string, unknown>, claves: string[]): unknown {
  for (const k of claves) if (o[k] != null && o[k] !== '') return o[k]
  return null
}

const CLAVES_SKU = ['sku', 'bajajCode', 'code', 'codigo', 'código', 'partNumber', 'part_number']
const CLAVES_ALT = ['skuAlt', 'altSku', 'codigoAlt', 'sku2', 'alt']
const CLAVES_QTY = ['qty', 'quantity', 'cantidad', 'cant', 'unidades']
const CLAVES_NOM = ['nombre', 'name', 'descripcion', 'descripción', 'description', 'detalle']

// Filas que no son piezas. Una cotización trae flete, impuestos y totales mezclados con
// los renglones de mercancía, y la IA los emite como si fueran SKU. Entrarían al embarque
// como una pieza sin peso y sin precio: invisible en el total, visible en el faltante.
const NO_ES_PIEZA = /^(shipping|freight|env[ií]o|flete|total|subtotal|tax|taxes|impuesto|gst|igst|handling|packing|discount|descuento|comisi[óo]n|commission)$/i

// Un código Bajaj es alfanumérico y compacto. Este filtro no valida contra el catálogo
// (eso lo hace la resolución); solo descarta lo que evidentemente es una frase.
const PARECE_CODIGO = /^[A-Za-z0-9][A-Za-z0-9./\- ]{2,23}$/

function normalizarFilas(filas: unknown[]): ListaParseada {
  const out = vacia()
  const porCodigo = new Map<string, SkuQty>()

  for (const [i, fila] of filas.entries()) {
    if (fila == null) continue
    const fuente = i + 1

    // Un string suelto en el array ("JR161036") es una línea válida de cantidad 1.
    const o: Record<string, unknown> =
      typeof fila === 'object' ? (fila as Record<string, unknown>) : { sku: fila }

    const nombre = toStr(primero(o, CLAVES_NOM))
    const qty = toQty(primero(o, CLAVES_QTY)) ?? 1
    const sku = toStr(primero(o, CLAVES_SKU))

    if (!sku) {
      if (nombre) out.sinCodigo.push({ nombre, qty })
      else out.avisos.push(`Fila ${fuente}: sin código ni descripción, se ignoró.`)
      continue
    }
    if (NO_ES_PIEZA.test(sku) || (nombre != null && NO_ES_PIEZA.test(nombre) && !PARECE_CODIGO.test(sku))) {
      out.avisos.push(`«${sku}» no es una pieza (flete, impuesto o total): no entra al embarque.`)
      continue
    }
    if (!PARECE_CODIGO.test(sku)) {
      out.sinCodigo.push({ nombre: nombre ?? sku, qty })
      out.avisos.push(`«${sku}» no parece un código Bajaj: quedó en la lista sin código.`)
      continue
    }

    const clave = sku.trim().toUpperCase()
    const ya = porCodigo.get(clave)
    if (ya) {
      // El mismo SKU dos veces suele ser la misma pieza en dos renglones del despiece.
      // Se suman las cantidades —que es lo que se va a comprar— y se avisa, porque
      // también puede ser que la IA duplicó una fila.
      ya.qty += qty
      out.avisos.push(`«${sku}» aparecía más de una vez: se sumaron las cantidades (${ya.qty}).`)
      continue
    }
    porCodigo.set(clave, { sku: sku.trim(), skuAlt: toStr(primero(o, CLAVES_ALT)), qty, nombre })
  }

  out.lineas = [...porCodigo.values()]
  return out
}

// Texto plano: "JR161036 x2", "JR161036,2", "JR161036 2 Pastilla de freno". El código es
// el primer token; la cantidad, el primer número suelto que lo siga.
function parseTextoPlano(raw: string): ListaParseada {
  const filas: unknown[] = []
  for (const cruda of raw.split(/\r?\n/)) {
    const linea = cruda.trim()
    if (!linea || linea.startsWith('#') || linea.startsWith('//')) continue
    const partes = linea.split(/[\t,;|]+|\s{2,}|\s+/).filter(Boolean)
    if (partes.length === 0) continue
    const sku = partes[0].replace(/[.:]+$/, '')
    // "x2" y "2" valen igual; el resto de las palabras son la descripción.
    const conCantidad = partes.slice(1).find(p => /^x?\d+$/i.test(p))
    const nombre = partes.slice(1).filter(p => p !== conCantidad).join(' ')
    filas.push({ sku, qty: conCantidad ? conCantidad.replace(/^x/i, '') : 1, nombre: nombre || null })
  }
  const res = normalizarFilas(filas)
  if (res.lineas.length > 0) {
    res.avisos.unshift('No era JSON válido, así que se leyó como texto: un código por línea. Revisá las cantidades.')
  }
  return res
}

/**
 * Lista pegada → códigos y cantidades.
 *
 * Acepta el array directo, `{ items: [...] }` (y sus sinónimos), un objeto suelto, o
 * texto plano si nada de eso parsea.
 */
export function parseListaSkus(raw: string): ListaParseada {
  const texto = raw.trim()
  if (!texto) {
    const v = vacia()
    v.errores.push('No pegaste nada.')
    return v
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(texto))
  } catch {
    const plano = parseTextoPlano(texto)
    if (plano.lineas.length === 0 && plano.sinCodigo.length === 0) {
      plano.errores.push('No pude leer la lista: no es JSON válido y ninguna línea parece un código.')
    }
    return plano
  }

  let filas: unknown[] = []
  let sinCodigoCrudo: unknown[] = []
  if (Array.isArray(parsed)) {
    filas = parsed
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['items', 'lineas', 'líneas', 'piezas', 'parts', 'productos']) {
      if (Array.isArray(o[k])) { filas = o[k] as unknown[]; break }
    }
    for (const k of ['sinCodigo', 'sinCódigo', 'sin_codigo', 'unmatched']) {
      if (Array.isArray(o[k])) { sinCodigoCrudo = o[k] as unknown[]; break }
    }
    if (filas.length === 0 && sinCodigoCrudo.length === 0) filas = [parsed]
  }

  const res = normalizarFilas(filas)

  // Lo que la IA declaró que no pudo codificar entra a la misma lista de pendientes: es
  // la mitad del trabajo que queda por hacer a mano y tiene que verse.
  for (const f of sinCodigoCrudo) {
    if (f == null) continue
    const o: Record<string, unknown> = typeof f === 'object' ? (f as Record<string, unknown>) : { nombre: f }
    const nombre = toStr(primero(o, CLAVES_NOM))
    if (nombre) res.sinCodigo.push({ nombre, qty: toQty(primero(o, CLAVES_QTY)) ?? 1 })
  }

  if (res.lineas.length === 0 && res.errores.length === 0) {
    res.errores.push('El JSON parseó pero no tenía ninguna línea con código.')
  }
  return res
}
