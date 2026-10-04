// Una línea de pedido es una PIEZA suelta o un CONJUNTO (un ensamble vendido a precio único),
// nunca las dos: `PedidoItem.productId` o `PedidoItem.ensambleId`, uno solo (el CHECK
// PedidoItem_pieza_xor_conjunto lo garantiza en la base).
//
// Este módulo concentra las dos preguntas que cada pantalla se hace sobre una línea, para que
// ninguna reinvente la distinción: "¿cuál es su identidad?" y "¿cómo se muestra?".

export interface RefLinea {
  productId: number | null
  ensambleId: number | null
}

/**
 * Identidad de una línea dentro de un presupuesto.
 *
 * Un id de pieza y uno de ensamble PUEDEN coincidir (son tablas distintas, cada una con su
 * secuencia): `productId` solo no alcanza. Cuando el ensamble vivía en `Product` los ids eran
 * disjuntos y bastaba el número; ya no. Es la clave de todo lo que indexa o deduplica líneas
 * (el carrito del armador, el diff de una edición, el costo por línea).
 */
export function claveLinea(l: RefLinea): string {
  return l.ensambleId != null ? `e${l.ensambleId}` : `p${l.productId}`
}

/**
 * Cómo se llama un ensamble. El nombre en inglés es el obligatorio y el de español es opcional,
 * así que se muestra el español si lo hay y, si no, el inglés.
 */
export function nombreEnsamble(e: { nameEs: string | null; nameEn: string }): string {
  return e.nameEs?.trim() || e.nameEn
}

/** Lo que una pantalla necesita para mostrar una línea, sea pieza o conjunto. */
export interface CabeceraLinea {
  esConjunto: boolean
  /** Id de la pieza o del ensamble: con `esConjunto` se sabe a qué página lleva. */
  id: number
  nameEs: string
  /** Un conjunto no tiene código propio: es la agrupación, no algo que se compre. */
  bajajCode: string | null
  compatibleModels: string | null
  imageUrl: string | null
}

interface PiezaRef {
  id: number
  nameEs: string
  bajajCode: string | null
  compatibleModels: string | null
  imageUrl: string | null
}

interface EnsambleRef {
  id: number
  nameEs: string | null
  nameEn: string
  compatibleModels: string
  imageUrl: string | null
}

/**
 * La cabecera de una línea cargada con `product` y `ensamble` incluidos.
 *
 * Una línea sin ninguno de los dos no puede existir (CHECK en la base). Si llegara, cortar es
 * mejor que renderizar una fila sin nombre y seguir con el costeo como si estuviera bien.
 */
export function cabeceraDeLinea(it: { product: PiezaRef | null; ensamble: EnsambleRef | null }): CabeceraLinea {
  if (it.ensamble) {
    const e = it.ensamble
    return { esConjunto: true, id: e.id, nameEs: nombreEnsamble(e), bajajCode: null, compatibleModels: e.compatibleModels, imageUrl: e.imageUrl }
  }
  if (it.product) {
    const p = it.product
    return { esConjunto: false, id: p.id, nameEs: p.nameEs, bajajCode: p.bajajCode, compatibleModels: p.compatibleModels, imageUrl: p.imageUrl }
  }
  throw new Error('Línea sin pieza ni conjunto: viola PedidoItem_pieza_xor_conjunto')
}
