'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { equivalenciasDe } from '@/lib/alt-sku'

// ─────────────────────────────────────────────────────────────────────────────
// Marcado en lote de piezas descontinuadas.
//
// Descontinuado es un hecho de la FÁBRICA: Bajaj dejó de producir el SKU, 99rpm lo rotula
// "(Discontinued/Supply-Disruption/NLS)" y a partir de ahí no la consigue ningún proveedor.
// Por eso se marca el producto y no el precio de un proveedor.
//
// Se carga por lista de códigos y no de a una porque así es como llega el dato: 99rpm
// rotula decenas de una, y el scraper (scripts/scrape-99rpm.ts) las junta. Esta pantalla es
// para cuando el dato lo tenés de otro lado — el proveedor te dice "esa no la traigo más" —
// sin esperar a re-scrapear.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoMarcado {
  /** Pasaron de vigentes a descontinuadas (o al revés, según la acción). */
  cambiados: number
  /** Ya estaban como quedaron: la lista tenía repetidos o ya se habían cargado. */
  sinCambio: number
  /** Códigos que no existen en el catálogo, ni por su número ni por el alterno. */
  noEncontrados: string[]
  /** Cuántos códigos distintos se leyeron del texto pegado. */
  leidos: number
}

/** Códigos Bajaj de un texto pegado: uno por línea, o separados por coma, ; o espacios. */
function parsearCodigos(texto: string): string[] {
  return [...new Set(
    texto.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean),
  )]
}

export async function marcarDescontinuados(
  texto: string,
  accion: 'marcar' | 'desmarcar',
): Promise<ResultadoMarcado> {
  const codigos = parsearCodigos(texto)
  if (codigos.length === 0) return { cambiados: 0, sinCambio: 0, noEncontrados: [], leidos: 0 }

  // El proveedor cotiza con SU número, que puede ser el otro del par: buscar solo por el
  // código propio dejaría afuera piezas que sí están cargadas. Ver lib/alt-sku.ts.
  const equiv = await equivalenciasDe(codigos)
  const todos = [...new Set([...equiv.values()].flat())]

  const productos = await db.product.findMany({
    where: { bajajCode: { in: todos } },
    select: { id: true, bajajCode: true, discontinuedAt: true },
  })

  const porCodigo = new Map(productos.map(p => [p.bajajCode!.trim().toUpperCase(), p]))
  const noEncontrados: string[] = []
  const aCambiar: number[] = []
  let sinCambio = 0

  for (const c of codigos) {
    const encontrados = (equiv.get(c) ?? [c])
      .map(e => porCodigo.get(e))
      .filter((p): p is NonNullable<typeof p> => p != null)

    if (encontrados.length === 0) { noEncontrados.push(c); continue }
    for (const p of encontrados) {
      const yaEsta = accion === 'marcar' ? p.discontinuedAt != null : p.discontinuedAt == null
      if (yaEsta) sinCambio++
      else aCambiar.push(p.id)
    }
  }

  // Los dos lados de un par apuntan al mismo producto en algunos casos: sin dedup, la
  // cuenta de "cambiados" saldría inflada.
  const ids = [...new Set(aCambiar)]
  if (ids.length > 0) {
    await db.product.updateMany({
      where: { id: { in: ids } },
      data: { discontinuedAt: accion === 'marcar' ? new Date() : null },
    })
    revalidatePath('/products')
    revalidatePath('/products/discontinued')
  }

  return { cambiados: ids.length, sinCambio, noEncontrados, leidos: codigos.length }
}
