import { parseModelos } from '@/lib/modelos'

// ─────────────────────────────────────────────────────────────────────────────
// Copiar el contenido de un embarque como JSON.
//
// Es la lista de compra saliendo de la app: lo que se le manda al proveedor para que
// cotice o para cerrar el pedido. Hermano de lib/export-ensamble.ts, pero la unidad es
// otra — allá es un ensamble del catálogo (piezas agrupadas por subgrupo, para elegir),
// acá es una CAJA ya armada: líneas planas con la cantidad que se va a pedir de verdad.
//
// Los campos llevan los nombres del que lo recibe, no los de la base (`minimo` y no `moq`,
// `precio` y no `costoUnitUsd`). Una vez que esto se pega en otro lado, renombrar acá
// rompe lo de allá.
//
// Lo que NO va: el flete, el FOB y el landed. Son costos MÍOS de traer la caja — el
// proveedor cotiza mercancía puesta en su depósito, y mandarle mi estructura de costos es
// mostrarle el margen. Por eso `precio` es el costo de compra, no el landed.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaEmbarqueJson {
  codigo: string | null
  /** El otro número de la misma pieza: muchos proveedores listan por este y no por el mío. */
  codigo_alt: string | null
  nombre: string
  cantidad: number
  /** Mínimo de compra declarado por el proveedor. `null` = no lo declara, que no es 1. */
  minimo: number | null
  /** Costo de compra UNITARIO en USD. `null` cuando no se conoce: un 0 sería un precio falso. */
  precio: number | null
  /** `precio × cantidad`, o `null` si no hay precio: no se inventa un total. */
  total: number | null
  /** Volumen de UNA unidad. `null` = sin dimensiones cargadas. */
  cm3: number | null
  /** Peso de UNA unidad. `null` = sin peso cargado. */
  kg: number | null
  compat_modelos: string[]
}

export interface EmbarqueJson {
  embarque: string
  proveedor: string | null
  nota?: string
  fecha: string
  /** Los totales son un PISO cuando hay piezas sin medir o sin precio; por eso van los contadores. */
  totales: {
    lineas: number
    unidades: number
    cm3: number
    kg: number
    usd: number
    sin_medidas: number
    sin_precio: number
  }
  lineas: LineaEmbarqueJson[]
}

/** Lo mínimo que necesita una línea para exportarse — la forma que ya tiene el armador. */
export interface LineaFuente {
  nameEs: string
  bajajCode: string | null
  altCode: string | null
  moq: number | null
  compatibleModels: string | null
  quantity: number
  /** Por UNIDAD. 0 = dato faltante (el armador no distingue null de 0 en estos tres). */
  volumeUnitM3: number
  weightUnitKg: number
  costoUnitUsd: number
}

export interface MetaEmbarque {
  embarque: string
  proveedor: string | null
  /** Para qué es esta lista, cuando no es obvia (un subconjunto, un pedido a otro proveedor). */
  nota?: string
}

const redondear = (n: number, decimales: number) => {
  const f = 10 ** decimales
  return Math.round(n * f) / f
}

/**
 * Arma el objeto del embarque a partir de sus líneas.
 *
 * Recibe las líneas ya elegidas: quién decide cuáles van es del que llama (el armador manda
 * su borrador local, que es lo que el usuario tiene en pantalla; la ficha cerrada manda lo
 * guardado). Así copiar siempre devuelve lo que se está viendo.
 */
export function embarqueAJson(meta: MetaEmbarque, lineas: LineaFuente[]): EmbarqueJson {
  const filas: LineaEmbarqueJson[] = lineas.map(l => {
    // 0 no se distingue de "no cargado" en la fuente, y de las tres magnitudes ninguna
    // puede ser 0 de verdad: una pieza que no pesa, no ocupa o no cuesta nada no existe.
    const precio = l.costoUnitUsd > 0 ? redondear(l.costoUnitUsd, 2) : null
    return {
      codigo: l.bajajCode,
      codigo_alt: l.altCode,
      nombre: l.nameEs,
      cantidad: l.quantity,
      minimo: l.moq,
      precio,
      total: precio != null ? redondear(precio * l.quantity, 2) : null,
      // m³ → cm³, con 2 decimales: un tornillo mide menos de 1 cm³ y truncarlo a entero lo
      // dejaría en 0, que se lee como "no ocupa nada".
      cm3: l.volumeUnitM3 > 0 ? redondear(l.volumeUnitM3 * 1_000_000, 2) : null,
      kg: l.weightUnitKg > 0 ? redondear(l.weightUnitKg, 3) : null,
      compat_modelos: parseModelos(l.compatibleModels),
    }
  })

  return {
    embarque: meta.embarque,
    proveedor: meta.proveedor,
    ...(meta.nota ? { nota: meta.nota } : {}),
    fecha: new Date().toISOString().slice(0, 10),
    totales: {
      lineas: filas.length,
      unidades: filas.reduce((s, f) => s + f.cantidad, 0),
      cm3: redondear(filas.reduce((s, f) => s + (f.cm3 ?? 0) * f.cantidad, 0), 2),
      kg: redondear(filas.reduce((s, f) => s + (f.kg ?? 0) * f.cantidad, 0), 3),
      usd: redondear(filas.reduce((s, f) => s + (f.total ?? 0), 0), 2),
      sin_medidas: filas.filter(f => f.cm3 == null).length,
      sin_precio: filas.filter(f => f.precio == null).length,
    },
    lineas: filas,
  }
}
