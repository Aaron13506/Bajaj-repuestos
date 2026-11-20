import { db } from '@/lib/db'
import { leerCodigo } from '@/lib/qr-bajaj'
import { codigoContiene, equivalenciasDe } from '@/lib/alt-sku'

// Una lectura del teléfono (o lo tecleado) contra TODO el catálogo: primero el código exacto o
// su alterno (doble SKU), y recién después, solo con `parcial` (lo tecleado), parte del código o
// del nombre. Lo usan los modos Consultar y Vender de /escanear. Devuelve hasta `limite + 1`
// piezas: la de más dice que hay más.
export async function buscarPorCodigo(raw: string, parcial: boolean, limite: number) {
  const { codigo, cantidad } = leerCodigo(raw)
  if (!codigo) return { codigo: raw.trim(), cantidad, exacto: false, piezas: [] }

  const eq = (await equivalenciasDe([codigo])).get(codigo) ?? [codigo]
  const select = { id: true, nameEs: true, bajajCode: true } as const
  const exactos = await db.product.findMany({
    where: { OR: eq.flatMap(c => [
      { bajajCode: { equals: c, mode: 'insensitive' as const } },
      { altSku: { equals: c, mode: 'insensitive' as const } },
    ]) },
    select,
    orderBy: { nameEs: 'asc' },
    take: limite + 1,
  })
  if (exactos.length > 0 || !parcial) return { codigo, cantidad, exacto: exactos.length > 0, piezas: exactos }

  const texto = { contains: raw.trim(), mode: 'insensitive' as const }
  const piezas = await db.product.findMany({
    where: { OR: [{ nameEs: texto }, { nameEn: texto }, ...(codigo.length >= 3 ? codigoContiene(codigo) : [])] },
    select,
    orderBy: { nameEs: 'asc' },
    take: limite + 1,
  })
  return { codigo, cantidad, exacto: false, piezas }
}

// "Leído como JR233069": el código leído si fue un alterno de la pieza encontrada.
export function leidoComo(r: { codigo: string; exacto: boolean }, bajajCode: string | null): string | null {
  return r.exacto && bajajCode?.trim().toUpperCase() !== r.codigo ? r.codigo : null
}
