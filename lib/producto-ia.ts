// ─────────────────────────────────────────────────────────────────────────────
// Leer la ficha de producto que devuelve la IA (productoPrompt, lib/prompts.ts). La foto no
// viene acá: se pega aparte en el formulario (components/PegarImagen.tsx).
//
// Puro y sin `db`: corre en el navegador, porque lo único que hace la respuesta es LLENAR
// el formulario de producto — nada se guarda hasta que el usuario lo revisa y aprieta
// Guardar, y ahí pasa por la misma acción que una carga a mano.
//
// Lo que no se puede usar se descarta con un aviso en vez de rechazar la ficha entera: un
// nombre y un precio buenos no tienen por qué perderse por una moto mal escrita. La única
// excepción son peso y medidas que el chequeo físico da por imposibles: esos no llenan nada,
// porque dejarlos en el formulario es invitar a guardarlos.
// ─────────────────────────────────────────────────────────────────────────────

import { extractJson } from '@/lib/json-ia'
import { chequearMedidas, hayError } from '@/lib/measures-check'
import { toModelIds, type MotoModelId } from '@/lib/modelo'

export interface FichaProductoIA {
  /** El SKU que el usuario le dio a la IA, devuelto tal cual (va a Product.bajajCode). */
  sku: string | null
  nameEs: string | null
  nameEn: string | null
  description: string | null
  /** null = la IA no dijo nada; [] = universal (lo dijo). */
  models: MotoModelId[] | null
  priceInr: number | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

export type LecturaFicha =
  | { ok: true; ficha: FichaProductoIA; avisos: string[] }
  | { ok: false; error: string }

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

// Acepta "1250" además de 1250: el prompt pide números, pero un número entre comillas no es
// razón para perder el dato. Lo que no sea un positivo finito es "no lo sé".
function positivo(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function leerFichaProducto(raw: string): LecturaFicha {
  if (!raw.trim()) return { ok: false, error: 'Pegá la respuesta de la IA.' }

  let data: unknown
  try {
    data = JSON.parse(extractJson(raw))
  } catch {
    return { ok: false, error: 'No encontré un JSON válido en la respuesta. Pegala completa, con el bloque ```json.' }
  }
  if (Array.isArray(data)) {
    if (data.length !== 1) return { ok: false, error: `La respuesta trae ${data.length} productos; este formulario carga uno.` }
    data = data[0]
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'El JSON no es un objeto con la ficha.' }
  const o = data as Record<string, unknown>
  const avisos: string[] = []

  // Motos: solo las etiquetas de la tabla. Las que no lo son se nombran, para que se
  // vea qué quiso decir la IA y se marque a mano si correspondía.
  let models: MotoModelId[] | null = null
  const crudas = o.compatibleModels ?? o.models
  if (crudas != null) {
    const lista = Array.isArray(crudas)
      ? crudas.filter((x): x is string => typeof x === 'string')
      : typeof crudas === 'string' ? crudas.split(',') : []
    models = toModelIds(lista)
    const descartadas = lista.map(s => s.trim()).filter(s => s && toModelIds([s]).length === 0)
    if (descartadas.length) {
      avisos.push(`Motos que no son del catálogo y no se marcaron: ${descartadas.join(', ')}.`)
    }
    if (lista.length && models.length === 0) models = null
  }

  const precio = positivo(o.priceInr)
  const priceInr = precio != null ? Math.round(precio) : null

  let medidas = {
    weightGrams: positivo(o.weightGrams),
    dimL: positivo(o.dimL),
    dimA: positivo(o.dimA),
    dimH: positivo(o.dimH),
  }
  if (medidas.weightGrams != null) medidas.weightGrams = Math.round(medidas.weightGrams * 10) / 10
  const completas = Object.values(medidas).every(v => v != null)
  if (!completas && Object.values(medidas).some(v => v != null)) {
    avisos.push('Peso y medidas vinieron incompletos: se cargan juntos, así que no se llenó ninguno.')
    medidas = { weightGrams: null, dimL: null, dimA: null, dimH: null }
  } else if (completas) {
    const chequeos = chequearMedidas(medidas)
    if (hayError(chequeos)) {
      avisos.push(`Peso y medidas rechazados, no se llenaron: ${chequeos.filter(c => c.severidad === 'error').map(c => c.mensaje).join(' ')}`)
      medidas = { weightGrams: null, dimL: null, dimA: null, dimH: null }
    } else {
      for (const c of chequeos) avisos.push(c.mensaje)
    }
  }

  return {
    ok: true,
    ficha: {
      sku: texto(o.sku) ?? texto(o.bajajCode),
      nameEs: texto(o.nameEs),
      nameEn: texto(o.nameEn),
      description: texto(o.description),
      models,
      priceInr,
      ...medidas,
    },
    avisos,
  }
}
