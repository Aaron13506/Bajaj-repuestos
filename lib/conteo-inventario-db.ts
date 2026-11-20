import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import { isUniqueViolation } from '@/lib/prisma-errors'
import { equivalenciasDe } from '@/lib/alt-sku'
import { leerEtiqueta, normUbicacion, UBICACION_MAX } from '@/lib/qr-bajaj'
import { normCodigo, resolverLectura } from '@/lib/conteo'
import { buscarPorCodigo } from '@/lib/buscar-codigo'
import { moverStock } from '@/lib/stock'
import {
  DIAS_RECIENTES, motivoNoCierraConteo, planCierreConteo, sugerirConteo, type FilaCierreConteo,
} from '@/lib/conteo-inventario'

// Ubicaciones y conteo cíclico contra la base (docs/plan-inventario/05-ubicaciones-conteo.md). Las
// reglas son puras en lib/conteo-inventario.ts. Todo lo que escribe en un conteo toma primero su
// candado (bloquearConteo: FOR UPDATE y verificar que siga abierto), así el teléfono y la laptop se
// serializan y el cierre no corre en medio de una lectura. Los ajustes van SOLO por moverStock con
// motivo 'conteo'.

type Tx = Prisma.TransactionClient
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const

// ── Ubicación de una pieza ───────────────────────────────────────────────────────────────────

/** El estante normalizado (tecleado "a 3" o escaneado "UBI:A-3"), o error legible si no sirve. Vacío = null. */
export function ubicacionValida(raw: string | null): string | null {
  const e = raw == null ? null : leerEtiqueta(raw)
  const u = e == null ? null : e.tipo === 'ubicacion' ? e.codigo : normUbicacion(raw!)
  if (u && u.length > UBICACION_MAX) throw new ErrorDeNegocio(`Una ubicación tiene hasta ${UBICACION_MAX} caracteres («${u}» es muy larga).`)
  return u
}

// Pone (o saca, con null) la ubicación de una pieza. Con `soloSiVacia` no pisa una que ya tenía
// (asignar al recibir). Escritura con guarda: si cambió entre leerla y escribirla, no pisa.
export async function asignarUbicacion(tx: Tx, productId: number, raw: string | null, soloSiVacia = false) {
  const ubicacion = ubicacionValida(raw)
  const p = await tx.product.findUnique({ where: { id: productId }, select: { ubicacion: true, bajajCode: true, nameEs: true } })
  if (!p) throw new ErrorDeNegocio('Esa pieza no existe.')
  const base = { codigo: p.bajajCode, nombre: p.nameEs, anterior: p.ubicacion, ubicacion: p.ubicacion }
  if (p.ubicacion === ubicacion || (soloSiVacia && p.ubicacion != null)) return { ...base, asignada: false }
  const r = await tx.product.updateMany({ where: { id: productId, ubicacion: p.ubicacion }, data: { ubicacion } })
  if (r.count === 0) throw new ErrorDeNegocio('La ubicación de la pieza cambió mientras tanto: reintentá.')
  return { ...base, ubicacion, asignada: true }
}

// ── Abrir ────────────────────────────────────────────────────────────────────────────────────

async function crearConteo(ubicacion: string | null, productIds: number[]): Promise<number> {
  return db.$transaction(async tx => {
    const ps = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, stock: true } })
    const c = await tx.conteoInventario.create({
      data: { ubicacion, abiertoAt: new Date(), lineas: { create: ps.map(p => ({ productId: p.id, sistema: p.stock })) } },
      select: { id: true },
    })
    return c.id
  }, TX_OPTS)
}

// Por estante: carga las piezas que tienen esa ubicación. Si ya hay uno abierto de ese estante,
// devuelve ese (un solo abierto por estante, índice ConteoInventario_uno_abierto).
export async function abrirConteoEstante(raw: string): Promise<number> {
  const ubicacion = ubicacionValida(raw)
  if (!ubicacion) throw new ErrorDeNegocio('Escaneá o escribí el estante (por ejemplo A-3).')
  const abierto = () => db.conteoInventario.findFirst({ where: { ubicacion, cerradoAt: null }, select: { id: true } })
  const ya = await abierto()
  if (ya) return ya.id
  const ids = (await db.product.findMany({ where: { ubicacion }, select: { id: true } })).map(p => p.id)
  try {
    return await crearConteo(ubicacion, ids)
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return (await abierto())!.id
  }
}

/** Por lista de piezas (la sugerida en /inventario/conteo). */
export async function abrirConteoLista(productIds: number[]): Promise<number> {
  const ids = [...new Set(productIds.filter(id => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) throw new ErrorDeNegocio('Elegí al menos una pieza para contar.')
  return crearConteo(null, ids)
}

// ── Ver ──────────────────────────────────────────────────────────────────────────────────────

export async function vistaConteo(id: number) {
  const c = await db.conteoInventario.findUnique({
    where: { id },
    select: {
      id: true, ubicacion: true, abiertoAt: true, cerradoAt: true, notas: true,
      lineas: {
        select: { id: true, productId: true, sistema: true, contado: true, product: { select: { nameEs: true, bajajCode: true, ubicacion: true, stock: true } } },
        orderBy: { id: 'asc' },
      },
    },
  })
  if (!c) return null
  const ids = c.lineas.map(l => l.productId)
  const [alternos, movidas] = await Promise.all([
    equivalenciasDe(c.lineas.flatMap(l => (l.product.bajajCode ? [l.product.bajajCode] : []))),
    c.cerradoAt ? Promise.resolve([]) : db.movimientoStock.findMany({
      where: { productId: { in: ids }, createdAt: { gt: c.abiertoAt } }, select: { productId: true }, distinct: ['productId'],
    }),
  ])
  const movidaSet = new Set(movidas.map(m => m.productId))
  return {
    ...c,
    lineas: c.lineas.map(l => {
      const propio = l.product.bajajCode ? normCodigo(l.product.bajajCode) : null
      return {
        id: l.id, productId: l.productId, sistema: l.sistema, contado: l.contado,
        codigo: l.product.bajajCode, nombre: l.product.nameEs, ubicacion: l.product.ubicacion,
        alternos: propio ? (alternos.get(propio) ?? []).filter(x => x !== propio) : [],
        stockAhora: l.product.stock, movidaDurante: movidaSet.has(l.productId),
      }
    }),
  }
}
export type VistaConteo = NonNullable<Awaited<ReturnType<typeof vistaConteo>>>
export type FilaConteoVista = VistaConteo['lineas'][number]

// ── Contar ───────────────────────────────────────────────────────────────────────────────────

async function bloquearConteo(tx: Tx, id: number) {
  const r = await tx.$queryRaw<{ ubicacion: string | null; cerradoAt: Date | null; abiertoAt: Date }[]>`
    SELECT "ubicacion", "cerradoAt", "abiertoAt" FROM "ConteoInventario" WHERE "id" = ${id} FOR UPDATE`
  if (!r[0]) throw new ErrorDeNegocio('Ese conteo no existe.')
  if (r[0].cerradoAt) throw new ErrorDeNegocio('Este conteo ya está cerrado.', 'cerrado')
  return r[0]
}

export type ResultadoConteo =
  | {
    tipo: 'sumo'; lineaId: number; productId: number; codigo: string | null; nombre: string; cantidad: number
    antes: number | null; contado: number
    /** Recién agregada al conteo (estaba en el estante y no en la lista). */
    nueva: boolean
    /** Tiene otra ubicación: "Estaba en B-1, ¿la muevo a A-3?". */
    estabaEn: string | null
  }
  | { tipo: 'varias'; piezas: { productId: number; codigo: string | null; nombre: string }[] }
  | { tipo: 'fuera_catalogo'; codigo: string }
  | { tipo: 'estante'; ubicacion: string; mismo: boolean }

// Una lectura: suma lo que trae la etiqueta (-2 suma 2; tecleado suma 1) en la fila de la pieza.
// Una pieza del catálogo que no estaba en la lista se agrega; si el conteo es de un estante y la
// pieza no tenía ubicación, se le asigna esa. Con `productId` (elegida de "varias") suma 1.
export async function leerEnConteo(conteoId: number, raw: string, manual: boolean, productId?: number): Promise<ResultadoConteo> {
  const e = leerEtiqueta(raw)
  if (e.tipo === 'ubicacion' && productId == null) {
    const c = await db.conteoInventario.findUnique({ where: { id: conteoId }, select: { ubicacion: true } })
    return { tipo: 'estante', ubicacion: e.codigo, mismo: c?.ubicacion === e.codigo }
  }
  const lectura = e.tipo === 'pieza' ? e : { codigo: '', cantidad: 1, raw }
  if (!lectura.codigo && productId == null) throw new ErrorDeNegocio('No se leyó ninguna etiqueta.')
  const cantidad = productId != null ? 1 : lectura.cantidad

  // Contra las filas del conteo primero (código, alterno y, tecleado, parte del código o nombre).
  let pid = productId
  if (pid == null) {
    const filas = await db.conteoInventarioLinea.findMany({ where: { conteoId }, select: { productId: true, product: { select: { nameEs: true, bajajCode: true } } } })
    const alt = await equivalenciasDe(filas.flatMap(f => (f.product.bajajCode ? [f.product.bajajCode] : [])))
    const piezas = filas.map(f => {
      const propio = f.product.bajajCode ? normCodigo(f.product.bajajCode) : null
      return { clave: String(f.productId), productId: f.productId, nombre: f.product.nameEs, codigo: f.product.bajajCode, alternos: propio ? (alt.get(propio) ?? []).filter(x => x !== propio) : [] }
    })
    const r = resolverLectura(piezas, lectura, manual)
    if ('pieza' in r) pid = r.pieza.productId
    else if ('varias' in r) return { tipo: 'varias', piezas: r.varias.map(p => ({ productId: p.productId, codigo: p.codigo, nombre: p.nombre })) }
    else {
      // No está en la lista: contra todo el catálogo.
      const cat = await buscarPorCodigo(raw, manual, 10)
      if (cat.piezas.length === 0) return { tipo: 'fuera_catalogo', codigo: cat.codigo }
      if (cat.piezas.length > 1) return { tipo: 'varias', piezas: cat.piezas.slice(0, 10).map(p => ({ productId: p.id, codigo: p.bajajCode, nombre: p.nameEs })) }
      pid = cat.piezas[0].id
    }
  }

  return db.$transaction(async tx => {
    const c = await bloquearConteo(tx, conteoId)
    const p = await tx.product.findUnique({ where: { id: pid }, select: { stock: true, bajajCode: true, nameEs: true } })
    if (!p) throw new ErrorDeNegocio('Esa pieza no existe.')
    const ins = await tx.conteoInventarioLinea.createMany({ data: [{ conteoId, productId: pid!, sistema: p.stock }], skipDuplicates: true })
    const nueva = ins.count > 0
    const antes = (await tx.conteoInventarioLinea.findUniqueOrThrow({ where: { conteoId_productId: { conteoId, productId: pid! } }, select: { contado: true } })).contado
    const l = await tx.conteoInventarioLinea.update({
      where: { conteoId_productId: { conteoId, productId: pid! } },
      data: { contado: (antes ?? 0) + cantidad },
      select: { id: true, contado: true },
    })
    // Una pieza del estante sin ubicación queda en este estante; si tenía otra, se pregunta.
    const u = c.ubicacion ? await asignarUbicacion(tx, pid!, c.ubicacion, true) : null
    return {
      tipo: 'sumo', lineaId: l.id, productId: pid!, codigo: p.bajajCode, nombre: p.nameEs, cantidad,
      antes, contado: l.contado!, nueva, estabaEn: u && !u.asignada && u.anterior !== c.ubicacion ? u.anterior : null,
    }
  }, TX_OPTS)
}

// "Eran 20" o el + / −: fija el total de la fila. null = vuelve a "sin contar". Con `si` (deshacer)
// solo escribe si la fila sigue como la dejó esa lectura: otra lectura en el medio no se pisa.
export async function corregirEnConteo(lineaId: number, total: number | null, si?: number | null): Promise<{ contado: number | null }> {
  if (total != null && (!Number.isInteger(total) || total < 0)) throw new ErrorDeNegocio('La cantidad tiene que ser un entero, 0 o más.')
  return db.$transaction(async tx => {
    const l = await tx.conteoInventarioLinea.findUnique({ where: { id: lineaId }, select: { conteoId: true } })
    if (!l) throw new ErrorDeNegocio('Esa fila ya no está en el conteo. Recargá.')
    await bloquearConteo(tx, l.conteoId)
    const r = await tx.conteoInventarioLinea.updateMany({ where: { id: lineaId, ...(si !== undefined ? { contado: si } : {}) }, data: { contado: total } })
    if (r.count === 0) throw new ErrorDeNegocio('La fila cambió mientras tanto (otra lectura): corregí el número a mano.')
    return { contado: total }
  }, TX_OPTS)
}

// "Estaba en B-1, ¿la muevo a A-3?" → sí.
export async function moverAlEstante(conteoId: number, productId: number) {
  return db.$transaction(async tx => {
    const c = await bloquearConteo(tx, conteoId)
    if (!c.ubicacion) throw new ErrorDeNegocio('Este conteo es por lista, no de un estante.')
    return asignarUbicacion(tx, productId, c.ubicacion)
  }, TX_OPTS)
}

// ── Cerrar ───────────────────────────────────────────────────────────────────────────────────

// Por cada fila contada con diferencia, un movimiento 'conteo' en el kardex contra el stock de
// AHORA (con las piezas bloqueadas, así una venta no se cuela entre leer y ajustar), y contadoAt en
// todas las contadas. El conteo se marca cerrado en la misma transacción: cerrar dos veces no
// duplica nada (la segunda encuentra el candado cerrado).
export async function cerrarConteo(id: number, notas: string | null): Promise<{ ajustes: number }> {
  return db.$transaction(async tx => {
    const c = await bloquearConteo(tx, id)
    const lineas = await tx.conteoInventarioLinea.findMany({ where: { conteoId: id }, select: { productId: true, sistema: true, contado: true } })
    const ids = lineas.map(l => l.productId)
    const stock = ids.length === 0 ? [] : await tx.$queryRaw<{ id: number; stock: number }[]>`
      SELECT "id", "stock" FROM "Product" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`
    const movidas = new Set((await tx.movimientoStock.findMany({
      where: { productId: { in: ids }, createdAt: { gt: c.abiertoAt } }, select: { productId: true }, distinct: ['productId'],
    })).map(m => m.productId))
    const stockDe = new Map(stock.map(s => [s.id, s.stock]))
    const filas: FilaCierreConteo[] = lineas.map(l => ({ ...l, stockAhora: stockDe.get(l.productId) ?? 0, movidaDurante: movidas.has(l.productId) }))
    const no = motivoNoCierraConteo(filas, notas)
    if (no) throw new ErrorDeNegocio(no)
    const plan = planCierreConteo(filas)
    const nota = [`Conteo #${id}${c.ubicacion ? ` (${c.ubicacion})` : ''}`, notas?.trim()].filter(Boolean).join(': ')
    await moverStock(tx, plan.ajustes.map(a => ({ ...a, motivo: 'conteo' as const, nota })), `conteo-${id}`)
    const ahora = new Date()
    await tx.product.updateMany({ where: { id: { in: plan.contadas } }, data: { contadoAt: ahora } })
    await tx.conteoInventario.update({ where: { id }, data: { cerradoAt: ahora, notas: notas?.trim() || null } })
    return { ajustes: plan.ajustes.length }
  }, TX_OPTS)
}

// ── Qué contar ───────────────────────────────────────────────────────────────────────────────

// Las piezas que conviene contar, la más urgente primero (lib/conteo-inventario.ts sugerirConteo).
// Fuera las que ya están en un conteo abierto.
export async function sugerenciasDeConteo(limite = 60) {
  const filas = await db.$queryRaw<{ id: number; nameEs: string; bajajCode: string | null; ubicacion: string | null; stock: number; contadoAt: Date | null; movimientos: number; ajustes: number }[]>`
    SELECT p."id", p."nameEs", p."bajajCode", p."ubicacion", p."stock", p."contadoAt",
      COUNT(m."id")::int AS "movimientos",
      COUNT(m."id") FILTER (WHERE m."motivo" = 'ajuste')::int AS "ajustes"
    FROM "Product" p
    LEFT JOIN "MovimientoStock" m ON m."productId" = p."id"
      AND m."motivo" NOT IN ('conteo', 'saldo_inicial')
      AND m."createdAt" > GREATEST((NOW() AT TIME ZONE 'UTC') - make_interval(days => ${DIAS_RECIENTES}), COALESCE(p."contadoAt", '-infinity'::timestamp))
    WHERE (p."stock" > 0 OR m."id" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "ConteoInventarioLinea" l JOIN "ConteoInventario" c ON c."id" = l."conteoId" WHERE l."productId" = p."id" AND c."cerradoAt" IS NULL)
    GROUP BY p."id"`
  const ahora = new Date()
  return filas
    .flatMap(f => { const s = sugerirConteo(f, ahora); return s ? [{ ...f, ...s }] : [] })
    .sort((a, b) => b.peso - a.peso || (a.ubicacion ?? '~').localeCompare(b.ubicacion ?? '~') || a.nameEs.localeCompare(b.nameEs))
    .slice(0, limite)
}
