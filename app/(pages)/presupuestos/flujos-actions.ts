'use server'

// Lo que le pasa a un pedido fuera del camino feliz: cancelarlo, devolverle plata al cliente,
// renovar un presupuesto vencido y anotar/resolver lo que le pasa a una línea (no disponible,
// dañada, perdida, incompleta, reclamo del cliente). Las reglas viven en lib/ (puras y chequeadas
// por `pnpm check:costeo`); acá solo se aplican, dentro de UNA transacción y bajo el cerrojo del
// pedido, con el mismo orden de siempre: pedido primero, sus movimientos después.
import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { revalidateClientes } from '@/lib/clientes'
import { ok, fallo, conErrorDeNegocio, ErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap, num } from '@/lib/config'
import { bloquearPedido, devolverACliente } from '@/lib/movimientos'
import { leerDevolucion } from '@/lib/devolucion'
import { bloquearDescontinuadas } from '@/lib/descontinuadas'
import { estadoLinea } from '@/lib/pedido-edicion'
import { motivoDevolucionInvalida, motivoNoCancelable, resumenCancelacion } from '@/lib/pedido-cancelacion'
import { crearReposicion, pasarAStockPropio, registrarEvento, SELECT_LINEA_MOVIBLE } from '@/lib/pedido-derivado'
import {
  RECLAMO_HORAS_DEFAULT, RESOLUCION_LABELS, TIPO_LABELS, dentroDePlazo, esResolucion, esTipoIncidencia, etiquetaPieza,
  motivoResolucionInvalida, origenPara, perdidaSugerida, planReembolso, tiposPara,
  type TipoIncidencia,
} from '@/lib/incidencias'
import { nombreEnsamble } from '@/lib/linea-pedido'
import type { BundlePiece } from '@/lib/bundle'
import { saldoReal } from '@/lib/saldo-entrega'

const dec = (v: { toString(): string } | null | undefined) => (v != null ? parseFloat(v.toString()) : null)
const usd = (n: number) => `$${n.toFixed(2)}`
const TX = { maxWait: 10_000, timeout: 20_000 } as const

function revalidarPedido(id: number, extra: number[] = []) {
  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  for (const e of extra) revalidatePath(`/presupuestos/${e}`)
  revalidatePath('/contabilidad')
  revalidatePath('/envios')
  revalidatePath('/inventario')
  revalidatePath('/resultados')
  revalidatePath('/')
  revalidateClientes()
}

function nombreDeLinea(it: {
  product: { nameEs: string } | null
  ensamble: { nameEs: string | null; nameEn: string } | null
}): string {
  return it.product?.nameEs ?? (it.ensamble ? nombreEnsamble(it.ensamble) : 'una línea')
}

// ── Cancelar ──────────────────────────────────────────────────────────────────────────────────

/**
 * Cancela un pedido de cliente confirmado. Ver lib/pedido-cancelacion.ts para las reglas.
 *
 * Lo ya comprado no se pierde: pasa a stock propio con su costo, su caja y su etapa. Lo que nunca
 * se compró sale de su caja. Lo cobrado se devuelve en lo que se escriba (o se queda, y entonces
 * es plata del negocio que se cuenta en el resultado del mes).
 */
export async function cancelarPedido(id: number, formData: FormData): Promise<ActionResult> {
  const motivo = (formData.get('motivo') as string)?.trim()
  if (!motivo) return fallo('Escribí por qué se cancela: queda en el historial del pedido.')
  const dev = leerDevolucion(formData)
  if (!dev.ok) return fallo(dev.error)

  const r = await conErrorDeNegocio(() => db.$transaction(async tx => {
    const actual = await bloquearPedido(tx, id)
    if (!actual) throw new ErrorDeNegocio(`El pedido #${id} ya no existe.`)

    const pedido = await tx.pedido.findUniqueOrThrow({
      where: { id },
      select: { tipo: true, status: true, clientName: true, items: { select: SELECT_LINEA_MOVIBLE } },
    })
    const items = pedido.items.map(i => ({ ...i, costReal: dec(i.costRealUsd) }))
    const no = motivoNoCancelable({
      tipo: pedido.tipo, status: pedido.status,
      items: items.map(i => ({ shippingStatus: i.shippingStatus, costRealUsd: i.costReal })),
    })
    if (no) throw new ErrorDeNegocio(no)

    const resumen = resumenCancelacion(items.map(i => ({ shippingStatus: i.shippingStatus, costRealUsd: i.costReal })))
    const invalido = dev.devolucion ? motivoDevolucionInvalida(dev.devolucion.monto, actual.depositUsd) : null
    if (invalido) throw new ErrorDeNegocio(invalido)

    // Primero la plata (si falla, no se tocó nada más).
    if (dev.devolucion) {
      await devolverACliente(tx, {
        pedidoId: id, monto: dev.devolucion.monto, fecha: dev.devolucion.fecha, metodoPago: dev.devolucion.metodoPago,
        descripcion: `Cancelación del pedido #${id}`, bs: dev.devolucion.bs,
      })
    }

    // Lo comprado pasa a stock propio; lo que no se compró sale de su caja y queda como memoria.
    const compradas = items.filter(i => estadoLinea({ shippingStatus: i.shippingStatus, costRealUsd: i.costReal }) === 'comprada')
    const libres = items.filter(i => !compradas.includes(i))
    let sobranteId: number | null = null
    if (compradas.length > 0) {
      const r = await pasarAStockPropio(tx, { id, clientName: pedido.clientName }, compradas.map(c => ({ linea: c, unidades: c.quantity })))
      sobranteId = r.pedidoId
    }
    await tx.pedidoItem.updateMany({ where: { id: { in: libres.map(l => l.id) }, envioId: { not: null } }, data: { envioId: null } })
    // Un "no disponible" abierto de lo que ya no se va a comprar deja de tener sentido.
    await tx.incidencia.updateMany({
      where: { pedidoId: id, estado: 'abierta', tipo: 'no_disponible' },
      data: { estado: 'resuelta', resolucion: 'sustituida', resueltaAt: new Date() },
    })

    await tx.pedido.update({ where: { id }, data: { status: 'cancelado', canceladoAt: new Date(), canceladoMotivo: motivo } })

    const retenido = Math.round((actual.depositUsd - (dev.devolucion?.monto ?? 0)) * 100) / 100
    const partes = [
      `Cancelado: ${motivo}`,
      dev.devolucion ? `Devuelto ${usd(dev.devolucion.monto)} (${dev.devolucion.metodoPago})` : 'No se devolvió nada',
      retenido > 0.005 ? `Se queda ${usd(retenido)}` : null,
      resumen.compradas > 0 ? `${resumen.compradas} línea(s) ya comprada(s) pasaron a stock propio (pedido #${sobranteId})` : null,
    ].filter(Boolean)
    await registrarEvento(tx, id, 'cancelado', partes.join('\n'))
  }, TX))

  if (r.ok) revalidarPedido(id)
  return r
}

// ── Devolver plata al cliente ────────────────────────────────────────────────────────────────

/**
 * Le devuelve al cliente lo que tiene de más: el saldo a favor que queda cuando un pedido se
 * edita a la baja, o lo que se decida de un pedido cancelado. No se devuelve más de lo cobrado,
 * ni, en un pedido vivo, más de lo que le sobra (devolver lo que el pedido todavía necesita lo
 * dejaría debiendo lo que ya había pagado).
 */
export async function devolverAlCliente(id: number, formData: FormData): Promise<ActionResult> {
  const dev = leerDevolucion(formData)
  if (!dev.ok) return fallo(dev.error)
  if (!dev.devolucion) return fallo('Escribí cuánto se le devuelve.')
  const d = dev.devolucion

  const r = await conErrorDeNegocio(() => db.$transaction(async tx => {
    const actual = await bloquearPedido(tx, id)
    if (!actual) throw new ErrorDeNegocio(`El pedido #${id} ya no existe.`)
    const p = await tx.pedido.findUniqueOrThrow({
      where: { id }, select: { tipo: true, status: true, items: { select: { salePrice: true, quantity: true } } },
    })
    if (p.tipo !== 'cliente' || (p.status !== 'pedido' && p.status !== 'cancelado')) {
      throw new ErrorDeNegocio('Solo se le devuelve plata a un cliente con un pedido confirmado o cancelado.')
    }
    if (p.status === 'pedido') {
      const sobra = -saldoReal(p.items.map(i => ({ salePrice: Number(i.salePrice), quantity: i.quantity })), actual.depositUsd)
      if (d.monto > sobra + 0.005) {
        throw new ErrorDeNegocio(
          sobra > 0.005
            ? `Solo se le puede devolver hasta ${usd(sobra)}: es lo que tiene de más. Con más quedaría debiendo.`
            : 'Este pedido no tiene saldo a favor: lo cobrado no pasa de lo que vale.',
        )
      }
    }
    await devolverACliente(tx, {
      pedidoId: id, monto: d.monto, fecha: d.fecha, metodoPago: d.metodoPago,
      descripcion: 'Devolución al cliente', bs: d.bs,
    })
    await registrarEvento(tx, id, 'devolucion', `Devuelto ${usd(d.monto)} (${d.metodoPago})`)
  }, TX))

  if (r.ok) revalidarPedido(id)
  return r
}

// ── Renovar un presupuesto ───────────────────────────────────────────────────────────────────

/**
 * Vuelve a cotizar un presupuesto vencido: nueva fecha y el escalón de hoy. No toca los precios —
 * eso es mirar el presupuesto y, si hace falta, editarlo—, pero sí corta si alguna pieza dejó de
 * fabricarse mientras tanto, porque renovar es volver a prometer.
 */
export async function renovarPresupuesto(id: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(async () => {
    const p = await db.pedido.findUnique({
      where: { id },
      select: { tipo: true, status: true, items: { select: { productId: true, ensambleId: true } } },
    })
    if (!p) throw new ErrorDeNegocio(`El presupuesto #${id} ya no existe.`)
    if (p.tipo !== 'cliente' || p.status !== 'presupuesto') throw new ErrorDeNegocio('Solo se renueva un presupuesto sin confirmar.')
    await bloquearDescontinuadas(p.items)
    const cfg = toConfigMap(await db.config.findMany())
    const escalon = escalonBcvVigente(cfg)
    await db.$transaction(async tx => {
      await tx.pedido.update({ where: { id }, data: { cotizadoAt: new Date(), escalonCotizadoPct: escalon } })
      await registrarEvento(tx, id, 'renovado', `Presupuesto renovado · escalón BCV ${escalon}%`)
    })
  })
  if (r.ok) revalidarPedido(id)
  return r
}

/**
 * Cierra un presupuesto que el cliente no aceptó, sin borrarlo: así cuenta en la conversión
 * (lib/validez.ts, embudo) y no queda abierto para siempre. Sigue siendo 'presupuesto'.
 */
export async function marcarPerdido(id: number, formData: FormData): Promise<ActionResult> {
  const motivo = String(formData.get('motivo') ?? '').trim() || null
  const hecho = await db.$transaction(async tx => {
    const r = await tx.pedido.updateMany({
      where: { id, tipo: 'cliente', status: 'presupuesto', perdidoAt: null },
      data: { perdidoAt: new Date(), perdidoMotivo: motivo },
    })
    if (r.count > 0) await registrarEvento(tx, id, 'perdido', `Presupuesto perdido${motivo ? `: ${motivo}` : ''}`)
    return r.count > 0
  })
  if (!hecho) return fallo('Solo se marca como perdido un presupuesto de cliente abierto. Recargá la página.')
  revalidarPedido(id)
  return ok()
}

/** Vuelve a abrir un presupuesto perdido (el cliente volvió). La validez sigue corriendo igual. */
export async function reabrirPresupuesto(id: number): Promise<ActionResult> {
  const hecho = await db.$transaction(async tx => {
    const r = await tx.pedido.updateMany({
      where: { id, status: 'presupuesto', perdidoAt: { not: null } },
      data: { perdidoAt: null, perdidoMotivo: null },
    })
    if (r.count > 0) await registrarEvento(tx, id, 'reabierto', 'Presupuesto reabierto')
    return r.count > 0
  })
  if (!hecho) return fallo('Ese presupuesto ya no está perdido. Recargá la página.')
  revalidarPedido(id)
  return ok()
}

// ── Incidencias ──────────────────────────────────────────────────────────────────────────────

/** Anota un problema de una línea. Lo que se puede anotar depende de dónde esté (ver tiposPara). */
export async function reportarIncidencia(itemId: number, formData: FormData): Promise<ActionResult> {
  const tipoRaw = String(formData.get('tipo') ?? '')
  if (!esTipoIncidencia(tipoRaw)) return fallo('Elegí qué le pasó a la pieza.')
  const tipo: TipoIncidencia = tipoRaw
  // En un conjunto casi nunca falta todo: falta UN SKU. Con `pieza` la cantidad sale de la pieza,
  // no se escribe (por eso puede venir vacía).
  const pieza = (formData.get('pieza') as string)?.trim() || null
  if (pieza && tipo !== 'no_disponible') return fallo('Solo se anota una pieza concreta cuando no está disponible.')
  const cantidadEscrita = parseInt(String(formData.get('cantidad') ?? ''), 10)
  if (!pieza && (!Number.isInteger(cantidadEscrita) || cantidadEscrita < 1)) return fallo('La cantidad tiene que ser un entero ≥ 1.')
  const nota = (formData.get('nota') as string)?.trim() || null

  const cfg = toConfigMap(await db.config.findMany())
  const horas = num(cfg, 'reclamo_horas', RECLAMO_HORAS_DEFAULT)

  let pedidoId = 0
  const r = await conErrorDeNegocio(async () => {
    const previo = await db.pedidoItem.findUnique({ where: { id: itemId }, select: { pedidoId: true } })
    if (!previo) throw new ErrorDeNegocio('Esa línea ya no existe. Recargá la página.')
    pedidoId = previo.pedidoId

    await db.$transaction(async tx => {
      const actual = await bloquearPedido(tx, pedidoId)
      if (!actual) throw new ErrorDeNegocio('Ese pedido ya no existe.')
      const it = await tx.pedidoItem.findUnique({
        where: { id: itemId },
        select: {
          ...SELECT_LINEA_MOVIBLE,
          pedido: { select: { tipo: true, status: true } },
          product: { select: { nameEs: true } },
          ensamble: { select: { nameEs: true, nameEn: true } },
        },
      })
      if (!it) throw new ErrorDeNegocio('Esa línea ya no existe. Recargá la página.')
      if (it.pedido.tipo !== 'cliente' || it.pedido.status !== 'pedido') {
        throw new ErrorDeNegocio('Solo se anotan problemas de un pedido de cliente confirmado.')
      }
      const linea = { shippingStatus: it.shippingStatus, costRealUsd: dec(it.costRealUsd) }
      if (!tiposPara(linea).includes(tipo)) {
        throw new ErrorDeNegocio(`Esta línea no admite «${TIPO_LABELS[tipo]}» en la etapa en que está.`)
      }
      let cantidad = cantidadEscrita
      let descripcion = nombreDeLinea(it)
      if (pieza) {
        const piezas = Array.isArray(it.bundleItems) ? (it.bundleItems as unknown as BundlePiece[]) : []
        const p = piezas.find(x => etiquetaPieza(x) === pieza)
        if (!p) throw new ErrorDeNegocio(`«${pieza}» no está en este conjunto (quizá ya se quitó). Recargá la página.`)
        const repetida = await tx.incidencia.count({ where: { itemId, estado: 'abierta', tipo: 'no_disponible', pieza } })
        if (repetida > 0) throw new ErrorDeNegocio(`«${pieza}» ya está marcada como no disponible.`)
        // Unidades de esa pieza que lleva la línea: por set × cantidad de sets.
        cantidad = p.quantity * it.quantity
        descripcion = `${descripcion} — ${pieza}`
      } else if (cantidad > it.quantity) {
        throw new ErrorDeNegocio(`La línea tiene ${it.quantity} unidad(es): no se puede anotar ${cantidad}.`)
      }

      const origen = origenPara(linea)
      let notaFinal = nota
      // Los términos dan un plazo para reclamar. Pasado, no se rechaza al cliente de entrada: se anota
      // como lo que es y la decisión (reponer igual, o "no procede") es del dueño al resolverla.
      if (origen === 'cliente' && !dentroDePlazo(it.shippingStatusAt, horas)) {
        const aviso = `⚠ Reclamo fuera del plazo de ${horas} h desde la entrega.`
        notaFinal = notaFinal ? `${aviso} ${notaFinal}` : aviso
      }
      const nombre = descripcion
      await tx.incidencia.create({
        data: { pedidoId, itemId, descripcion: nombre, pieza, tipo, origen, cantidad, nota: notaFinal },
      })
      await registrarEvento(
        tx, pedidoId, 'incidencia',
        `${origen === 'cliente' ? 'Reclamo del cliente' : 'Problema'}: ${TIPO_LABELS[tipo]} · ${cantidad}× «${nombre}»` + (nota ? ` — ${nota}` : ''),
      )
    }, TX)
  })
  if (r.ok) revalidarPedido(pedidoId)
  return r
}

/**
 * Cierra una incidencia abierta. Qué hace con la plata cada resolución está en lib/incidencias.ts:
 * `reposicion` crea un pedido a $0; `reembolso` baja lo vendido, saca de la línea el costo de esas
 * unidades y lo deja como pérdida del pedido (opcionalmente devolviéndole plata al cliente).
 */
export async function resolverIncidencia(incidenciaId: number, formData: FormData): Promise<ActionResult> {
  const resolucionRaw = String(formData.get('resolucion') ?? '')
  if (!esResolucion(resolucionRaw)) return fallo('Elegí cómo se resuelve.')
  const resolucion = resolucionRaw
  const notaCierre = (formData.get('nota') as string)?.trim() || null
  const perdidaCruda = String(formData.get('perdidaUsd') ?? '').trim().replace(',', '.')
  const perdidaEscrita = perdidaCruda === '' ? null : parseFloat(perdidaCruda)
  if (perdidaEscrita != null && (!Number.isFinite(perdidaEscrita) || perdidaEscrita < 0)) {
    return fallo('La pérdida no es un monto válido.')
  }
  const dev = leerDevolucion(formData)
  if (!dev.ok) return fallo(dev.error)

  let pedidoId = 0
  let reposicionId: number | null = null
  const r = await conErrorDeNegocio(async () => {
    const previo = await db.incidencia.findUnique({ where: { id: incidenciaId }, select: { pedidoId: true } })
    if (!previo) throw new ErrorDeNegocio('Esa incidencia ya no existe. Recargá la página.')
    pedidoId = previo.pedidoId

    await db.$transaction(async tx => {
      const actual = await bloquearPedido(tx, pedidoId)
      if (!actual) throw new ErrorDeNegocio('Ese pedido ya no existe.')
      const inc = await tx.incidencia.findUnique({
        where: { id: incidenciaId },
        include: {
          pedido: { select: { id: true, clientName: true, clienteId: true, tipo: true, status: true } },
          item: { select: SELECT_LINEA_MOVIBLE },
        },
      })
      if (!inc) throw new ErrorDeNegocio('Esa incidencia ya no existe. Recargá la página.')
      // Una segunda pestaña o un doble click la encuentran ya cerrada y no hacen nada más.
      if (inc.estado !== 'abierta') throw new ErrorDeNegocio('Esa incidencia ya estaba resuelta. Recargá la página.')
      if (!esTipoIncidencia(inc.tipo)) throw new ErrorDeNegocio('Incidencia con un tipo desconocido.')
      const origen = inc.origen === 'cliente' ? 'cliente' : 'operacion'
      const linea = inc.item
        ? { quantity: inc.item.quantity, salePrice: Number(inc.item.salePrice), costRealUsd: dec(inc.item.costRealUsd) }
        : null

      const invalido = motivoResolucionInvalida({
        tipo: inc.tipo, origen, cantidad: inc.cantidad, resolucion, linea, perdidaUsd: perdidaEscrita,
      })
      if (invalido) throw new ErrorDeNegocio(invalido)
      if ((resolucion === 'reposicion' || resolucion === 'reembolso') && (inc.pedido.tipo !== 'cliente' || inc.pedido.status !== 'pedido')) {
        throw new ErrorDeNegocio('Solo se repone o reembolsa en un pedido de cliente confirmado.')
      }

      const cierre = { estado: 'resuelta', resolucion, resueltaAt: new Date() }
      const detalle: string[] = [
        `${TIPO_LABELS[inc.tipo]} · ${inc.cantidad}× «${inc.descripcion}» → ${RESOLUCION_LABELS[resolucion]}`,
      ]

      if (resolucion === 'reposicion') {
        reposicionId = await crearReposicion(tx, inc.pedido, inc.item!, inc.cantidad)
        await tx.incidencia.update({ where: { id: inc.id }, data: { ...cierre, reposicionId } })
        detalle.push(`Pedido de reposición #${reposicionId}`)
      } else if (resolucion === 'reembolso') {
        const it = inc.item!
        const perdida = perdidaEscrita ?? perdidaSugerida(linea!.costRealUsd, linea!.quantity, inc.cantidad)
        const plan = planReembolso(linea!, inc.cantidad, perdida)
        await tx.incidencia.update({ where: { id: inc.id }, data: { ...cierre, perdidaUsd: plan.perdidaUsd } })
        if (plan.quitaLinea) {
          await tx.pedidoItem.delete({ where: { id: it.id } })
        } else {
          await tx.pedidoItem.update({ where: { id: it.id }, data: { quantity: plan.quedan, costRealUsd: plan.costRealNuevo } })
        }
        detalle.push(`Baja lo vendido ${usd(plan.bajaVentaUsd)}` + (plan.perdidaUsd > 0 ? ` · pérdida ${usd(plan.perdidaUsd)}` : ''))
        if (dev.devolucion) {
          await devolverACliente(tx, {
            pedidoId, monto: dev.devolucion.monto, fecha: dev.devolucion.fecha, metodoPago: dev.devolucion.metodoPago,
            descripcion: `Reembolso: ${inc.descripcion}`, bs: dev.devolucion.bs,
          })
          detalle.push(`Devuelto ${usd(dev.devolucion.monto)} (${dev.devolucion.metodoPago})`)
        }
      } else {
        await tx.incidencia.update({ where: { id: inc.id }, data: cierre })
      }

      if (notaCierre) detalle.push(notaCierre)
      await registrarEvento(tx, pedidoId, 'incidencia_resuelta', detalle.join('\n'))
    }, TX)
  })
  if (r.ok) revalidarPedido(pedidoId, reposicionId != null ? [reposicionId] : [])
  return r
}
