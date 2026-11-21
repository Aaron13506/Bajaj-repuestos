import { Prisma } from '@prisma/client'
import type { BultoLlegada } from '@/lib/cajas-envio'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import { isUniqueViolation } from '@/lib/prisma-errors'
import type { BundlePiece } from '@/lib/bundle'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { sinEnviarDe } from '@/lib/incidencias'
import { resolverDePiezas } from '@/lib/inventario'
import { equivalenciasDe } from '@/lib/alt-sku'
import { leerEtiqueta, type OrigenLectura } from '@/lib/qr-bajaj'
import { asignarUbicacion } from '@/lib/conteo-inventario-db'
import { normCodigo, resolverLectura, type PiezaAContar } from '@/lib/conteo'
import { buscarPorCodigo, leidoComo } from '@/lib/buscar-codigo'
import { moverStock, StockInsuficiente } from '@/lib/stock'
import { moverEtapasEn } from '@/lib/mover-etapas'
import { contextoCosteo, costearMaritimo, ENVIO_COSTEO_INCLUDE } from '@/lib/costo-envios'
import {
  claveDe, destinoDeUnidades, esDecision, esperadoDeRecepcion, estadoFila, pendienteDeLinea, planCierre, puedeCerrar,
  type EstadoFila, type FilaEsperada, type LineaCaja,
} from '@/lib/recepcion'

// La recepción contra la base (docs/plan-inventario/03-recepcion.md). Las reglas son puras en
// lib/recepcion.ts; acá se leen los datos, se toma el candado y se ejecuta el plan. Fuera de las
// acciones para que scripts/check-etapas-sql.ts lo pruebe sin el runtime de Next.
//
// Todo lo que toca una recepción toma primero su candado (bloquearRecepcion: SELECT … FOR UPDATE
// y verificar que siga abierta), igual que bloquearPedido: el teléfono y la laptop escriben a la vez
// por las mismas funciones y se serializan ahí.

type Tx = Prisma.TransactionClient
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const

async function bloquearRecepcion(tx: Tx, id: number) {
  const r = await tx.$queryRaw<{ envioId: number; cerradaAt: Date | null }[]>`
    SELECT "envioId", "cerradaAt" FROM "Recepcion" WHERE "id" = ${id} FOR UPDATE`
  if (!r[0]) throw new ErrorDeNegocio('Esa recepción no existe.')
  if (r[0].cerradaAt) throw new ErrorDeNegocio('Esta recepción ya está cerrada.', 'cerrada')
  return r[0]
}

// La línea de la mesa vuelve a ser la suma de sus lecturas no anuladas (vacío si no queda ninguna).
async function recalcular(tx: Tx, lineaId: number): Promise<number | null> {
  const r = await tx.$queryRaw<{ contado: number | null }[]>`
    UPDATE "RecepcionLinea" SET "contado" = (
      SELECT SUM("cantidad")::int FROM "RecepcionLectura" WHERE "lineaId" = ${lineaId} AND "anuladaAt" IS NULL
    ) WHERE "id" = ${lineaId} RETURNING "contado"`
  return r[0]?.contado ?? null
}

// ── Lo que espera la caja ────────────────────────────────────────────────────────────────────

// Las líneas de pedido que viajan en una caja aérea (o express), con lo que necesita lib/recepcion.
export async function lineasDeCaja(tx: Tx, envioId: number): Promise<LineaCaja[]> {
  const items = await tx.pedidoItem.findMany({
    where: { envioId, isLanded: false, shippingStatus: { not: 'pendiente' }, pedido: { status: 'pedido' } },
    select: {
      id: true, pedidoId: true, quantity: true, shippingStatus: true, productId: true, bundleItems: true,
      product: { select: { nameEs: true, bajajCode: true } },
      ensamble: { select: { nameEs: true, nameEn: true } },
      pedido: { select: { tipo: true, createdAt: true } },
      incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { tipo: true, estado: true, cantidad: true, pieza: true, recepcionId: true } },
    },
  })
  const conBundle = items.map(it => ({ ...it, bundleItems: it.bundleItems as BundlePiece[] | null }))
  const resolver = await resolverDePiezas(conBundle)
  return conBundle.map(it => ({
    itemId: it.id,
    pedidoId: it.pedidoId,
    propio: it.pedido.tipo === 'propio',
    orden: it.pedido.createdAt.getTime(),
    shippingStatus: it.shippingStatus,
    quantity: it.quantity,
    nombre: it.ensamble ? nombreEnsamble(it.ensamble) : it.product?.nameEs ?? '—',
    codigo: it.ensamble ? null : it.product?.bajajCode ?? null,
    productId: it.productId,
    piezas: (it.bundleItems ?? []).map(p => ({ ...p, productId: resolver(p) })),
    sinEnviarManual: sinEnviarDe(it.incidencias.filter(i => i.recepcionId == null)),
    sinEnviarRecepcion: sinEnviarDe(it.incidencias.filter(i => i.recepcionId != null)),
  }))
}

// Las filas que la caja espera HOY, fuera de la recepción `salvo` (la abierta).
async function filasEsperadas(tx: Tx, envio: { id: number; modo: string }, salvo?: number): Promise<FilaEsperada[]> {
  if (envio.modo !== 'maritimo_cbm') return esperadoDeRecepcion((await lineasDeCaja(tx, envio.id)).flatMap(pendienteDeLinea))
  const [caja, lineas, anteriores] = await Promise.all([
    tx.envio.findUniqueOrThrow({ where: { id: envio.id }, select: { estado: true } }),
    tx.envioLinea.findMany({ where: { envioId: envio.id }, select: { productId: true, quantity: true, product: { select: { nameEs: true, bajajCode: true } } } }),
    tx.recepcionLinea.findMany({
      where: { recepcion: { envioId: envio.id, cerradaAt: { not: null }, revertidaAt: null, ...(salvo ? { id: { not: salvo } } : {}) } },
      select: { codigo: true, esperado: true, contado: true, decision: true },
    }),
  ])
  // Recibida antes del registro de recepciones: ya sumó a stock, no espera nada.
  if (caja.estado === 'entregado' && anteriores.length === 0) return []
  return esperadoDeRecepcion(lineas.map(l => ({
    clave: claveDe(l.product.bajajCode, l.product.nameEs), codigo: l.product.bajajCode, nombre: l.product.nameEs,
    productId: l.productId, etiqueta: null, unidades: l.quantity,
  })), anteriores)
}

/** Lo que la caja todavía espera recibir (fuera de una recepción abierta): vacío = nada que contar. */
export async function pendienteDeRecibir(envio: { id: number; modo: string }): Promise<FilaEsperada[]> {
  return filasEsperadas(db, envio)
}

/** Por qué no se puede cambiar el contenido de la caja, o null: con una recepción abierta, no. */
export async function motivoRecepcionAbierta(envioId: number): Promise<string | null> {
  const r = await db.recepcion.findFirst({ where: { envioId, cerradaAt: null }, select: { id: true } })
  return r ? 'La caja se está contando (recepción abierta): cerrala o terminá el conteo antes de cambiar lo que lleva.' : null
}

// ── Abrir ────────────────────────────────────────────────────────────────────────────────────

async function abrirEn(tx: Tx, envio: { id: number; modo: string }): Promise<number | null> {
  const filas = await filasEsperadas(tx, envio)
  if (filas.length === 0) return null
  const r = await tx.recepcion.create({
    data: { envioId: envio.id, lineas: { create: filas.map(f => ({ codigo: f.codigo, productId: f.productId, nombre: f.nombre, esperado: f.esperado })) } },
    select: { id: true },
  })
  return r.id
}

// Abre la recepción de la caja (o devuelve la que ya está abierta). Con `llegada` además marca el
// check-in: la caja está en mis manos. Se puede contar sin marcar la llegada ("abrirlo antes").
// Devuelve null si la caja no espera nada (ya recibida entera).
export async function abrirRecepcion(envioId: number, opts: { llegada?: boolean; nota?: string | null; bulto?: BultoLlegada } = {}): Promise<number | null> {
  try {
    return await db.$transaction(async tx => {
      const envio = await tx.envio.findUnique({ where: { id: envioId }, select: { id: true, modo: true, estado: true } })
      if (!envio) throw new ErrorDeNegocio('Esa caja no existe.')
      if (envio.estado === 'borrador') throw new ErrorDeNegocio('En borrador no hay nada que recibir: confirmá la caja primero.')
      if (opts.llegada) {
        await tx.envio.updateMany({ where: { id: envioId, llegadaAt: null }, data: { llegadaAt: new Date(), llegadaNota: opts.nota?.trim() || null, ...opts.bulto } })
      }
      const abierta = await tx.recepcion.findFirst({ where: { envioId, cerradaAt: null }, select: { id: true } })
      if (abierta) return abierta.id
      const id = await abrirEn(tx, envio)
      if (id == null && !opts.llegada) throw new ErrorDeNegocio('La caja no espera nada: ya se recibió todo lo que lleva.')
      return id
    }, TX_OPTS)
  } catch (e) {
    // Dos pantallas abrieron a la vez: el índice Recepcion_una_abierta dejó entrar a una.
    if (!isUniqueViolation(e)) throw e
    return (await db.recepcion.findFirst({ where: { envioId, cerradaAt: null }, select: { id: true } }))?.id ?? null
  }
}

export async function cambiarCiego(recepcionId: number, ciego: boolean): Promise<void> {
  await db.recepcion.updateMany({ where: { id: recepcionId, cerradaAt: null }, data: { ciego } })
}

// ── Contar ───────────────────────────────────────────────────────────────────────────────────

export type ResultadoLectura =
  | { tipo: 'sumo'; lecturaId: number; lineaId: number; codigo: string | null; nombre: string; cantidad: number; contado: number; esperado: number; estado: EstadoFila; leidoComo: string | null
    /** A qué estante va (putaway); null = sin ubicación: la próxima etiqueta UBI: se la asigna. */
    ubicacion: string | null; enCatalogo: boolean
    /** A quién van las unidades leídas: cliente null = stock (propio, marítimo o sobrante). */
    para?: { pedidoId: number | null; cliente: string | null; unidades: number }[] }
  | { tipo: 'varias'; filas: { lineaId: number; codigo: string | null; nombre: string }[] }
  | { tipo: 'no_esperada'; codigo: string; nombre: string; cantidad: number }
  | { tipo: 'fuera_catalogo'; codigo: string; cantidad: number }
  // Una etiqueta de estante: no suma. Se la asigna a la última pieza leída si no tenía ubicación.
  | { tipo: 'estante'; ubicacion: string; codigo: string | null; nombre: string | null; asignada: boolean; tenia: string | null }

const filaAPieza = (f: { id: number; codigo: string | null; nombre: string }, alternos: Map<string, string[]>): PiezaAContar & { id: number } => {
  const propio = f.codigo ? normCodigo(f.codigo) : null
  return { id: f.id, clave: String(f.id), nombre: f.nombre, codigo: f.codigo, alternos: propio ? (alternos.get(propio) ?? []).filter(c => c !== propio) : [] }
}

async function sumar(tx: Tx, recepcionId: number, lineaId: number, raw: string | null, cantidad: number, origen: OrigenLectura) {
  const l = await tx.recepcionLectura.create({ data: { recepcionId, lineaId, raw, cantidad, origen }, select: { id: true } })
  const contado = await recalcular(tx, lineaId)
  return { lecturaId: l.id, contado: contado ?? 0 }
}

// Una lectura (cámara, lector o tecleado): suma lo que trae la etiqueta en su fila. Lo que no es
// de la caja NO suma: vuelve para que la pantalla ofrezca anotarlo (anotarCodigo) o ignorarlo.
// Con `lineaId` (elegida de "varias"), suma 1 en esa fila.
export async function registrarLectura(recepcionId: number, raw: string, origen: OrigenLectura, lineaId?: number): Promise<ResultadoLectura> {
  const etiqueta = leerEtiqueta(raw)
  if (etiqueta.tipo === 'ubicacion' && lineaId == null) return ubicarUltimaLeida(recepcionId, etiqueta.codigo)
  const lectura = etiqueta.tipo === 'pieza' ? etiqueta : { codigo: '', cantidad: 1, raw }
  if (!lectura.codigo && lineaId == null) throw new ErrorDeNegocio('No se leyó ninguna etiqueta.')
  return db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const filas = await tx.recepcionLinea.findMany({ where: { recepcionId }, select: { id: true, codigo: true, nombre: true, esperado: true, productId: true } })
    let fila = lineaId != null ? filas.find(f => f.id === lineaId) : undefined
    const cantidad = lineaId != null ? 1 : lectura.cantidad
    let como: string | null = null
    if (lineaId != null && !fila) throw new ErrorDeNegocio('Esa fila ya no está en la recepción. Recargá.')
    if (!fila) {
      const alternos = await equivalenciasDe(filas.flatMap(f => (f.codigo ? [f.codigo] : [])))
      const piezas = filas.map(f => filaAPieza(f, alternos))
      const r = resolverLectura(piezas, lectura, origen === 'manual')
      if ('varias' in r) return { tipo: 'varias', filas: r.varias.map(p => ({ lineaId: p.id, codigo: p.codigo, nombre: p.nombre })) }
      if ('ninguna' in r) {
        const cat = await buscarPorCodigo(raw, false, 1)
        return cat.piezas.length > 0
          ? { tipo: 'no_esperada', codigo: cat.piezas[0].bajajCode ?? cat.codigo, nombre: cat.piezas[0].nameEs, cantidad: lectura.cantidad }
          : { tipo: 'fuera_catalogo', codigo: lectura.codigo, cantidad: lectura.cantidad }
      }
      fila = filas.find(f => f.id === r.pieza.id)!
      como = fila.codigo && normCodigo(fila.codigo) !== lectura.codigo && r.pieza.alternos.includes(lectura.codigo) ? lectura.codigo : null
    }
    const s = await sumar(tx, recepcionId, fila.id, lineaId != null ? null : raw, cantidad, origen)
    const estado = estadoFila(s.contado, fila.esperado)
    const para = fila.esperado > 0
      ? await paraQuien(tx, recepcionId, claveDe(fila.codigo, fila.nombre), s.contado - cantidad, s.contado)
      : [{ pedidoId: null, cliente: null, unidades: cantidad }]
    return { tipo: 'sumo', ...s, lineaId: fila.id, codigo: fila.codigo, nombre: fila.nombre, cantidad, esperado: fila.esperado, estado, leidoComo: como, ubicacion: await ubicacionDe(tx, fila.productId), enCatalogo: fila.productId != null, para }
  }, TX_OPTS)
}

// A qué cliente (o stock) van las unidades recién leídas, para separarlas al contar.
async function paraQuien(tx: Tx, recepcionId: number, clave: string, desde: number, hasta: number) {
  if (hasta <= desde) return []
  const { envio } = await tx.recepcion.findUniqueOrThrow({ where: { id: recepcionId }, select: { envio: { select: { id: true, modo: true } } } })
  if (envio.modo === 'maritimo_cbm') return [{ pedidoId: null, cliente: null, unidades: hasta - desde }]
  const destinos = destinoDeUnidades(await lineasDeCaja(tx, envio.id), clave, desde, hasta)
  const ids = destinos.flatMap(d => (d.pedidoId != null ? [d.pedidoId] : []))
  const nombres = new Map(ids.length === 0 ? [] : (await tx.pedido.findMany({ where: { id: { in: ids } }, select: { id: true, clientName: true } })).map(p => [p.id, p.clientName]))
  return destinos.map(d => ({ ...d, cliente: d.pedidoId == null ? null : nombres.get(d.pedidoId) ?? `Pedido #${d.pedidoId}` }))
}

const ubicacionDe = async (tx: Tx, productId: number | null) =>
  productId == null ? null : (await tx.product.findUnique({ where: { id: productId }, select: { ubicacion: true } }))?.ubicacion ?? null

// "UBI:A-3" durante la recepción (putaway): la última pieza leída en esta recepción queda en ese
// estante si no tenía ubicación. Si ya tenía una, no la pisa (moverla es desde Consultar o un conteo).
async function ubicarUltimaLeida(recepcionId: number, ubicacion: string): Promise<ResultadoLectura> {
  return db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const ultima = await tx.recepcionLectura.findFirst({
      where: { recepcionId, anuladaAt: null },
      orderBy: { id: 'desc' },
      select: { linea: { select: { productId: true, codigo: true, nombre: true } } },
    })
    if (!ultima) return { tipo: 'estante', ubicacion, codigo: null, nombre: null, asignada: false, tenia: null }
    // La última fue algo fuera del catálogo: no hay pieza a la que ponerle lugar.
    if (ultima.linea.productId == null) return { tipo: 'estante', ubicacion, codigo: ultima.linea.codigo, nombre: ultima.linea.nombre, asignada: false, tenia: null }
    const u = await asignarUbicacion(tx, ultima.linea.productId!, ubicacion, true)
    return { tipo: 'estante', ubicacion: u.ubicacion ?? ubicacion, codigo: u.codigo, nombre: u.nombre, asignada: u.asignada, tenia: u.asignada ? null : u.anterior }
  }, TX_OPTS)
}

// "Anotar": lo leído que no viene en esta caja entra como fila con esperado 0 y suma. Si está en el
// catálogo queda enlazado (al cerrar es sobrante, o el lugar de una equivocada); si no, queda con el
// código y sin pieza, y frena el cierre hasta crear la pieza o descartarla.
export async function anotarCodigo(recepcionId: number, raw: string, origen: OrigenLectura): Promise<ResultadoLectura> {
  const lectura = leerEtiqueta(raw)
  if (lectura.tipo === 'ubicacion') throw new ErrorDeNegocio('Eso es una etiqueta de estante, no una pieza.')
  if (!lectura.codigo) throw new ErrorDeNegocio('No se leyó ningún código.')
  const cat = await buscarPorCodigo(raw, false, 1)
  const p = cat.piezas.length === 1 ? cat.piezas[0] : null
  const codigo = p ? claveDe(p.bajajCode, p.nameEs) : lectura.codigo
  return db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const fila = await tx.recepcionLinea.upsert({
      where: { recepcionId_codigo: { recepcionId, codigo } },
      create: { recepcionId, codigo, productId: p?.id ?? null, nombre: p?.nameEs ?? codigo, esperado: 0 },
      update: {},
      select: { id: true, codigo: true, nombre: true, esperado: true },
    })
    const s = await sumar(tx, recepcionId, fila.id, raw, lectura.cantidad, origen)
    const estado = estadoFila(s.contado, fila.esperado)
    return {
      tipo: 'sumo', ...s, lineaId: fila.id, codigo: fila.codigo, nombre: fila.nombre, cantidad: lectura.cantidad,
      esperado: fila.esperado, estado, leidoComo: p ? leidoComo(cat, p.bajajCode) : null,
      ubicacion: await ubicacionDe(tx, p?.id ?? null), enCatalogo: p != null,
      para: [{ pedidoId: null, cliente: null, unidades: lectura.cantidad }],
    }
  }, TX_OPTS)
}

async function recepcionDeLinea(tx: Tx, lineaId: number) {
  const l = await tx.recepcionLinea.findUnique({ where: { id: lineaId }, select: { recepcionId: true, contado: true } })
  if (!l) throw new ErrorDeNegocio('Esa fila ya no está en la recepción. Recargá.')
  return l
}

// "Eran 20, no 2": una lectura manual con la diferencia. 0 = la busqué y no está (o "descartar").
export async function corregirConteo(lineaId: number, nuevoTotal: number): Promise<{ contado: number; estado: EstadoFila; para: Awaited<ReturnType<typeof paraQuien>> }> {
  if (!Number.isInteger(nuevoTotal) || nuevoTotal < 0) throw new ErrorDeNegocio('La cantidad tiene que ser un entero, 0 o más.')
  return db.$transaction(async tx => {
    const { recepcionId } = await recepcionDeLinea(tx, lineaId)
    await bloquearRecepcion(tx, recepcionId)
    const { contado } = (await recepcionDeLinea(tx, lineaId))
    const f = await tx.recepcionLinea.findUniqueOrThrow({ where: { id: lineaId }, select: { codigo: true, nombre: true, esperado: true } })
    if (contado === nuevoTotal) return { contado, estado: estadoFila(contado, f.esperado), para: [] }
    const s = await sumar(tx, recepcionId, lineaId, null, nuevoTotal - (contado ?? 0), 'manual')
    // Al sumar con + también dice para qué cliente (o stock) es lo agregado.
    const para = s.contado > (contado ?? 0)
      ? (f.esperado > 0 ? await paraQuien(tx, recepcionId, claveDe(f.codigo, f.nombre), contado ?? 0, s.contado) : [{ pedidoId: null, cliente: null, unidades: s.contado - (contado ?? 0) }])
      : []
    return { contado: s.contado, estado: estadoFila(s.contado, f.esperado), para }
  }, TX_OPTS)
}

// "Deshacer": la lectura queda anulada (no se borra) y su fila vuelve a sumar sin ella.
export async function deshacerLectura(lecturaId: number): Promise<{ lineaId: number; contado: number | null }> {
  return db.$transaction(async tx => {
    const l = await tx.recepcionLectura.findUnique({ where: { id: lecturaId }, select: { recepcionId: true, lineaId: true, cantidad: true } })
    if (!l) throw new ErrorDeNegocio('Esa lectura ya no existe.')
    await bloquearRecepcion(tx, l.recepcionId)
    const r = await tx.recepcionLectura.updateMany({ where: { id: lecturaId, anuladaAt: null }, data: { anuladaAt: new Date() } })
    if (r.count === 0) return { lineaId: l.lineaId, contado: (await recepcionDeLinea(tx, l.lineaId)).contado }
    const { contado } = await recepcionDeLinea(tx, l.lineaId)
    if ((contado ?? 0) - l.cantidad < 0) throw new ErrorDeNegocio('Deshacerla dejaría la fila en negativo: corregí el número a mano.')
    return { lineaId: l.lineaId, contado: await recalcular(tx, l.lineaId) }
  }, TX_OPTS)
}

// Una pieza sin etiqueta y desconocida: fila sin código que frena el cierre hasta identificarla o descartarla.
export async function anotarSinIdentificar(recepcionId: number, nota: string, cantidad = 1): Promise<void> {
  if (!nota.trim()) throw new ErrorDeNegocio('Escribí qué es (una nota para reconocerla después).')
  if (!Number.isInteger(cantidad) || cantidad < 1) throw new ErrorDeNegocio('La cantidad tiene que ser un entero, 1 o más.')
  await db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const f = await tx.recepcionLinea.create({ data: { recepcionId, codigo: null, nombre: nota.trim(), esperado: 0, nota: nota.trim() }, select: { id: true } })
    await sumar(tx, recepcionId, f.id, null, cantidad, 'manual')
  }, TX_OPTS)
}

// Asigna una fila sin identificar (o fuera del catálogo) a una pieza. Si la recepción ya tiene una
// fila de ese código, las lecturas pasan a esa y esta desaparece.
export async function identificar(lineaId: number, productId: number): Promise<void> {
  const p = await db.product.findUnique({ where: { id: productId }, select: { id: true, nameEs: true, bajajCode: true } })
  if (!p) throw new ErrorDeNegocio('Esa pieza no existe.')
  const codigo = claveDe(p.bajajCode, p.nameEs)
  await db.$transaction(async tx => {
    const { recepcionId } = await recepcionDeLinea(tx, lineaId)
    await bloquearRecepcion(tx, recepcionId)
    const destino = await tx.recepcionLinea.findUnique({ where: { recepcionId_codigo: { recepcionId, codigo } }, select: { id: true } })
    if (destino && destino.id !== lineaId) {
      await tx.recepcionLectura.updateMany({ where: { lineaId }, data: { lineaId: destino.id } })
      await tx.recepcionLinea.delete({ where: { id: lineaId } })
      await recalcular(tx, destino.id)
    } else {
      await tx.recepcionLinea.update({ where: { id: lineaId }, data: { codigo, productId: p.id, nombre: p.nameEs } })
    }
  }, TX_OPTS)
}

// La pieza recién creada desde "Crear pieza" se enlaza sola con las filas abiertas de su código.
export async function enlazarPiezaNueva(productId: number, bajajCode: string | null): Promise<void> {
  if (!bajajCode?.trim()) return
  await db.recepcionLinea.updateMany({
    where: { codigo: { equals: bajajCode.trim(), mode: 'insensitive' }, productId: null, recepcion: { cerradaAt: null } },
    data: { productId },
  })
}

// ── Cerrar ───────────────────────────────────────────────────────────────────────────────────

// Costo por unidad de cada pieza de una caja marítima: su landed repartido como lo hace el inventario.
async function costoUnitMaritimo(envioId: number): Promise<Map<number, number | null>> {
  const e = await db.envio.findUniqueOrThrow({ where: { id: envioId }, include: ENVIO_COSTEO_INCLUDE })
  const m = costearMaritimo(e, await contextoCosteo([e]))
  const base = m.resumen.landedUsd
  const out = new Map<number, number | null>()
  for (const pz of m.resumen.piezas) {
    if (pz.productId == null || pz.quantity <= 0) continue
    out.set(pz.productId, pz.sinPrecio || base <= 0 ? null : Math.round((m.landedUsd * pz.landedUsd / base / pz.quantity) * 100) / 100)
  }
  return out
}

// Cierra la recepción: escribe lo que dice planCierre (etapas, stock con moverStock, incidencias) y
// la deja cerrada. `decisiones` va por id de fila. Primero, en su propia transacción, refresca lo
// esperado contra lo que la caja lleva hoy y guarda las decisiones (no se pierden si el cierre se niega).
export async function cerrarRecepcion(recepcionId: number, decisiones: Record<number, string>): Promise<void> {
  const r0 = await db.recepcion.findUnique({ where: { id: recepcionId }, select: { envio: { select: { id: true, modo: true } } } })
  if (!r0) throw new ErrorDeNegocio('Esa recepción no existe.')
  const envio = r0.envio
  const maritimo = envio.modo === 'maritimo_cbm'

  await db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const frescas = await filasEsperadas(tx, envio, recepcionId)
    const actuales = await tx.recepcionLinea.findMany({ where: { recepcionId }, select: { id: true, codigo: true, esperado: true, contado: true, decision: true, productId: true } })
    const porCodigo = new Map(actuales.flatMap(a => (a.codigo != null ? [[a.codigo, a] as const] : [])))
    for (const f of frescas) {
      const a = porCodigo.get(f.codigo)
      if (!a) await tx.recepcionLinea.create({ data: { recepcionId, codigo: f.codigo, productId: f.productId, nombre: f.nombre, esperado: f.esperado } })
      else if (a.esperado !== f.esperado || (a.productId == null && f.productId != null)) {
        await tx.recepcionLinea.update({ where: { id: a.id }, data: { esperado: f.esperado, productId: a.productId ?? f.productId } })
        a.esperado = f.esperado
      }
    }
    const frescasCod = new Set(frescas.map(f => f.codigo))
    for (const a of actuales) {
      if (a.codigo != null && !frescasCod.has(a.codigo) && a.esperado > 0) {
        await tx.recepcionLinea.update({ where: { id: a.id }, data: { esperado: 0 } })
        a.esperado = 0
      }
      const pedida = decisiones[a.id]
      const falta = a.contado != null && a.contado < a.esperado
      const decision = !falta ? null : pedida && esDecision(pedida) ? pedida : a.decision
      if (decision !== a.decision) await tx.recepcionLinea.update({ where: { id: a.id }, data: { decision } })
    }
  }, TX_OPTS)

  const costoUnit = maritimo ? await costoUnitMaritimo(envio.id) : null

  await db.$transaction(async tx => {
    await bloquearRecepcion(tx, recepcionId)
    const filas = await tx.recepcionLinea.findMany({ where: { recepcionId }, select: { codigo: true, productId: true, nombre: true, esperado: true, contado: true, decision: true } })
    const no = puedeCerrar(filas)
    if (no) throw new ErrorDeNegocio(no)
    const lineas = maritimo ? [] : await lineasDeCaja(tx, envio.id)
    const plan = planCierre(filas, maritimo ? { modo: 'maritimo', costoUnit: costoUnit! } : { modo: 'aereo', lineas })

    const cerrada = await tx.recepcion.updateMany({
      where: { id: recepcionId, cerradaAt: null },
      data: { cerradaAt: new Date(), itemsMovidos: plan.etapas.map(e => e.itemId) },
    })
    if (cerrada.count === 0) throw new ErrorDeNegocio('Esta recepción ya está cerrada.', 'cerrada')

    const movidas = await moverEtapasEn(tx, envio.id, plan.etapas.map(e => ({ id: e.itemId, desde: e.desde, hacia: e.hacia, signo: 0 })))
    if (movidas !== plan.etapas.length) throw new ErrorDeNegocio('Una línea de la caja cambió de etapa mientras se cerraba. Recargá y volvé a cerrar.')

    if (plan.backordersCerrados.length > 0) {
      await tx.incidencia.updateMany({
        where: { itemId: { in: plan.backordersCerrados }, estado: 'abierta', tipo: 'sin_enviar', recepcionId: { not: null } },
        data: { estado: 'resuelta', resolucion: 'llego', resueltaAt: new Date(), recepcionCierreId: recepcionId },
      })
    }
    if (plan.incidencias.length > 0) {
      await tx.incidencia.createMany({ data: plan.incidencias.map(i => ({ ...i, origen: 'operacion', recepcionId })) })
    }
    await moverStock(tx, plan.stock.map(m => ({ ...m, envioId: envio.id, recepcionId })), `recepcion-${recepcionId}`)

    await tx.envio.updateMany({ where: { id: envio.id, llegadaAt: null }, data: { llegadaAt: new Date() } })
    if (maritimo) await tx.envio.updateMany({ where: { id: envio.id, estado: 'confirmado' }, data: { estado: 'entregado', entregadoAt: new Date() } })
  }, TX_OPTS)
}

// ── Revertir ─────────────────────────────────────────────────────────────────────────────────

// Deshace una recepción cerrada con contramovimientos: resta el stock que sumó, borra sus
// incidencias (si siguen abiertas), reabre los backorders que cerró, devuelve las líneas que movió
// a camino_venezuela (o la caja marítima a confirmado) y abre una recepción nueva con todo lo esperado.
// Solo la última recepción de la caja.
export async function revertirRecepcion(recepcionId: number): Promise<number | null> {
  return db.$transaction(async tx => {
    const r = (await tx.$queryRaw<{ envioId: number; cerradaAt: Date | null; revertidaAt: Date | null; itemsMovidos: number[] }[]>`
      SELECT "envioId", "cerradaAt", "revertidaAt", "itemsMovidos" FROM "Recepcion" WHERE "id" = ${recepcionId} FOR UPDATE`)[0]
    if (!r) throw new ErrorDeNegocio('Esa recepción no existe.')
    if (!r.cerradaAt) throw new ErrorDeNegocio('La recepción sigue abierta: no hay nada que revertir.')
    if (r.revertidaAt) throw new ErrorDeNegocio('Esta recepción ya se revirtió.')
    const posterior = await tx.recepcion.findFirst({ where: { envioId: r.envioId, id: { gt: recepcionId } }, select: { id: true } })
    if (posterior) throw new ErrorDeNegocio(`Hay una recepción posterior (#${posterior.id}) en esta caja: revertí esa primero.`)
    const envio = await tx.envio.findUniqueOrThrow({ where: { id: r.envioId }, select: { id: true, modo: true } })

    const suyas = await tx.incidencia.findMany({ where: { recepcionId }, select: { id: true, estado: true, descripcion: true } })
    const resueltas = suyas.filter(i => i.estado !== 'abierta')
    if (resueltas.length > 0) {
      throw new ErrorDeNegocio(`Ya se resolvió una incidencia de esta recepción (${resueltas[0].descripcion}): no se puede revertir.`)
    }
    await tx.incidencia.deleteMany({ where: { recepcionId, estado: 'abierta' } })
    await tx.incidencia.updateMany({
      where: { recepcionCierreId: recepcionId },
      data: { estado: 'abierta', resolucion: null, resueltaAt: null, recepcionCierreId: null },
    })

    const movs = await tx.movimientoStock.findMany({ where: { recepcionId, cantidad: { gt: 0 } }, select: { productId: true, cantidad: true, pedidoId: true, pedidoItemId: true } })
    try {
      await moverStock(tx, movs.map(m => ({ ...m, cantidad: -m.cantidad, motivo: 'reversa_recepcion' as const, envioId: envio.id, recepcionId })), `reversa-recepcion-${recepcionId}`)
    } catch (e) {
      if (!(e instanceof StockInsuficiente)) throw e
      throw new ErrorDeNegocio(
        `No se puede revertir: ya no hay en stock lo que esta recepción sumó (${e.piezas.slice(0, 3).join(', ')}). ` +
        'Se vendió o se ajustó a mano; corregí ese stock primero.',
      )
    }

    if (r.itemsMovidos.length > 0) {
      const items = await tx.pedidoItem.findMany({ where: { id: { in: r.itemsMovidos } }, select: { id: true, pedido: { select: { tipo: true } } } })
      const filas = items.map(it => ({ id: it.id, desde: it.pedido.tipo === 'propio' ? 'entregado' : 'en_venezuela', hacia: 'camino_venezuela', signo: 0 }))
      const n = await moverEtapasEn(tx, envio.id, filas)
      if (n !== r.itemsMovidos.length) {
        throw new ErrorDeNegocio('Una línea de esta recepción ya no está donde la dejó (¿se entregó al cliente?): no se puede revertir.')
      }
    }

    await tx.recepcion.update({ where: { id: recepcionId }, data: { revertidaAt: new Date() } })
    if (envio.modo === 'maritimo_cbm') {
      const otra = await tx.recepcion.findFirst({ where: { envioId: envio.id, cerradaAt: { not: null }, revertidaAt: null }, select: { id: true } })
      if (!otra) await tx.envio.updateMany({ where: { id: envio.id, estado: 'entregado' }, data: { estado: 'confirmado', entregadoAt: null } })
    }
    return abrirEn(tx, envio)
  }, TX_OPTS)
}

// ── Lo que muestran las pantallas ────────────────────────────────────────────────────────────

// Una pieza de la caja que el conteo ofrece medir: estimada, o medida sin base conocida (sinBase).
export interface Estimada { productId: number; weightGrams: number | null; dimL: number | null; dimA: number | null; dimH: number | null; sinBase: boolean }

// Por código: las que se ofrecen medir al contarlas (07-casos-telefono.md). Un código que
// resuelve a dos productos no se ofrece: no se sabe a cuál se le guardaría.
export async function estimadasDe(codigos: string[]): Promise<Record<string, Estimada>> {
  const out: Record<string, Estimada> = {}
  if (codigos.length === 0) return out
  const prods = await db.product.findMany({
    where: { bajajCode: { in: codigos } },
    select: { id: true, bajajCode: true, medidoAt: true, medidaBase: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
  })
  for (const c of codigos) {
    const mismos = prods.filter(p => p.bajajCode === c)
    const x = mismos.length === 1 ? mismos[0] : null
    if (x && (x.medidoAt == null || x.medidaBase == null)) {
      out[c] = { productId: x.id, weightGrams: x.weightGrams, dimL: x.dimL, dimA: x.dimA, dimH: x.dimH, sinBase: x.medidoAt != null }
    }
  }
  return out
}

export async function vistaRecepcion(recepcionId: number) {
  const r = await db.recepcion.findUnique({
    where: { id: recepcionId },
    select: {
      id: true, envioId: true, ciego: true, abiertaAt: true, cerradaAt: true, revertidaAt: true,
      envio: { select: { id: true, nombre: true, modo: true, supplier: { select: { name: true } } } },
      lineas: { select: { id: true, codigo: true, productId: true, nombre: true, esperado: true, contado: true, decision: true, nota: true }, orderBy: [{ nombre: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!r) return null
  const codigos = r.lineas.flatMap(l => (l.codigo ? [l.codigo] : []))
  const alternos = codigos.length > 0 ? await equivalenciasDe(codigos) : new Map<string, string[]>()
  return {
    ...r,
    lineas: r.lineas.map(l => ({ ...l, alternos: filaAPieza(l, alternos).alternos })),
  }
}
export type VistaRecepcion = NonNullable<Awaited<ReturnType<typeof vistaRecepcion>>>
export type FilaVista = VistaRecepcion['lineas'][number]
