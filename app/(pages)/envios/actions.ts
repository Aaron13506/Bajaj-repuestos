'use server'

import { cuentaDeMetodo } from '@/lib/cuentas'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isDelivered, isPending, isValidStatus, normalizeToRoute, routeFor } from '@/lib/shipping-status'
import { bloqueaCompra, bloqueaEntrega, etiquetaPieza, lineaNoViene, sinEnviarDe } from '@/lib/incidencias'
import { reportarNoVinoVarios, resolverIncidencia } from '@/app/(pages)/presupuestos/flujos-actions'
import { seEntregaDesdeElPedido } from '@/lib/saldo-entrega'
import { inboundDe } from '@/lib/inbound'
import { isModoApp, llevaPedidos, MODOS_CON_PEDIDOS } from '@/lib/modo'
import { motivoExpressNoAprobable, motivoViaNoCoincide, topeDeCaja } from '@/lib/express'
import { contextoCosteo, costearAereo, ENVIO_COSTEO_INCLUDE } from '@/lib/costo-envios'
import { isReenvio, reenvioDe, ETAPAS_FUERA_DEL_DEPOSITO, motivoReenvioNoCoincide } from '@/lib/reenvio'
import { fallo, ok, conErrorDeNegocio, ErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { isForeignKeyViolation } from '@/lib/prisma-errors'
import { compraTrasMover, motivoNoMueve, motivoNoMueveSinEnviar, type CajaParaMover } from '@/lib/mover-caja'
import { avanzaSinEstar, motivoNoDespacha, planSeparar } from '@/lib/sin-stock'
import { bloquearPedido } from '@/lib/movimientos'
import { registrarEvento, SELECT_LINEA_MOVIBLE } from '@/lib/pedido-derivado'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { CATEGORIAS_EGRESO } from '@/lib/movimientos'
import { listarFaltantes, piezasDeLinea } from '@/lib/stock-piezas'
import { moverEtapas, type FilaEtapa, type PiezaEtapa } from '@/lib/mover-etapas'
import { resolverDePiezas } from '@/lib/inventario'
import type { BundlePiece } from '@/lib/bundle'
import {
  TRAMOS_FLETE, CATEGORIAS_FLETE, esTramoFlete, excedeFacturado, type TramoFlete,
} from '@/lib/flete-real'
import { TRAMOS_TRACKING, TRAMO_TRACKING_META, leerTrackingsTramo, type FilaTracking } from '@/lib/tracking'
import { ETAPAS_CAJA, leerCajasEtapa, type CajaFisica, type CampoCaja, type EtapaCaja } from '@/lib/cajas-envio'
import { apiKeyShip24, courierDeFila, ENV_API_KEY } from '@/lib/ship24'
import { listaCouriers, refrescarCouriers, sincronizarOneway, sincronizarTrackings } from '@/lib/sync-trackings'
import { credencialesOneway, esCodigoOneway, ONEWAY_CODE, ONEWAY_NOMBRE } from '@/lib/oneway'

// Crea una caja. La RUTA se elige acá y no se vuelve a tocar: es lo que decide con qué
// cadena logística se costea y, sobre todo, qué se puede meter adentro.
//
//   aéreo    → se llena asignándole PEDIDOS (carga comercial).
//   marítimo → se llena pieza por pieza con mercancía propia.
//
// Las dos nacen en BORRADOR. El aéreo nacía confirmado ("sus líneas ya existen"), pero que
// existan las líneas no dice que se vayan a comprar: se arman muchos pedidos propios para
// pensar una compra, y meterlos en una caja es parte de pensarla. Mientras la caja no se
// confirma (confirmarCajaAerea) nada de lo que lleva cuenta como inventario en camino, ni
// se puede comprar, pagar ni mover de etapa.
export async function createEnvio(formData: FormData): Promise<ActionResult> {
  const nombre = (formData.get('nombre') as string)?.trim() || null
  const notas = (formData.get('notas') as string)?.trim() || null
  const raw = formData.get('modo') as string
  const modo = isModoApp(raw) ? raw : 'aereo'
  const estado = 'borrador'

  // El proveedor se elige acá, en las DOS rutas, y ya no se toca. Antes solo se preguntaba
  // en el marítimo porque por aire se le compraba siempre a 99rpm; dejó de ser cierto
  // cuando empezaron a convivir una caja de Shoppre y una de Garuda viajando en paralelo.
  //
  // Se congela al crear porque decide todo lo demás: el precio de cada pieza, si el tramo a
  // USA lo cobra la tabla escalón o lo factura el proveedor, qué etapas tiene la ruta, y el
  // FOB en el marítimo. Vacío = 99rpm, el precio base en ₹.
  const supplierRaw = parseInt((formData.get('supplierId') as string) ?? '')
  const supplierId = Number.isFinite(supplierRaw) ? supplierRaw : null

  // El reenvío (Shoppre o por kilo) también se congela acá. Solo cuenta en el aéreo y el express
  // (por kilo = express por USA) y solo para lo que pasa por un depósito: si el proveedor
  // despacha él, se ignora.
  const reenvioRaw = formData.get('reenvio') as string | null
  if (reenvioRaw != null && reenvioRaw !== '' && !isReenvio(reenvioRaw)) return fallo('Ese reenvío no existe.')
  let reenvio = (modo === 'aereo' || modo === 'express') && isReenvio(reenvioRaw) ? reenvioRaw : 'shoppre'
  if (reenvio !== 'shoppre' && supplierId != null) {
    const sp = await db.supplier.findUnique({ where: { id: supplierId }, select: { origen: true, inbound: true } })
    if (sp && inboundDe(sp.origen, sp.inbound) === 'cotizado') reenvio = 'shoppre'
  }

  // Express es Shoppre despachando desde su depósito: un proveedor que manda él mismo a USA no
  // tiene cómo entrar ahí.
  if (modo === 'express' && supplierId != null) {
    const sp = await db.supplier.findUnique({ where: { id: supplierId }, select: { origen: true, inbound: true } })
    if (sp && inboundDe(sp.origen, sp.inbound) === 'cotizado') {
      return fallo('Ese proveedor despacha él mismo: no pasa por el depósito de Shoppre, así que no va por express.')
    }
  }

  let envio
  try {
    envio = await db.envio.create({ data: { nombre, notas, modo, estado, supplierId, reenvio } })
  } catch (e) {
    // El proveedor se borró desde otra pestaña después de armar el selector.
    if (isForeignKeyViolation(e)) return fallo('Ese proveedor ya no existe. Recargá la página.')
    throw e
  }

  revalidatePath('/envios')
  redirect(`/envios/${envio.id}`)
}

// Confirma una caja aérea: lo que lleva pasa a ser una compra en firme. Desde acá cuenta
// como inventario en camino (las líneas propias, ver lib/inventario.ts) y se puede comprar,
// pagar y avanzar. Una caja vacía no se confirma: no hay compra.
//
// Transición guardada (`updateMany where estado = 'borrador'`), como las del marítimo: un
// doble click o una segunda pestaña no hacen nada la segunda vez.
export async function confirmarCajaAerea(envioId: number): Promise<ActionResult> {
  // Una caja express pasada del tope no se despacha: confirmarla sería comprarla igual. La express
  // por USA (reenvío por kilo) va DDP y no tiene tope.
  const caja = await db.envio.findUnique({ where: { id: envioId }, include: ENVIO_COSTEO_INCLUDE })
  if (caja?.modo === 'express' && caja.reenvio !== 'por_kilo' && caja.estado === 'borrador') {
    const ctx = await contextoCosteo([caja])
    const motivo = motivoExpressNoAprobable(topeDeCaja(costearAereo(caja, ctx).calc, ctx.cfg))
    if (motivo) return fallo(motivo)
  }

  const r = await db.envio.updateMany({
    where: { id: envioId, modo: { in: [...MODOS_CON_PEDIDOS] }, estado: 'borrador', items: { some: {} } },
    data: { estado: 'confirmado' },
  })
  if (r.count === 0) {
    const e = await db.envio.findUnique({ where: { id: envioId }, select: { estado: true } })
    if (!e) return fallo('Ese envío ya no existe.')
    if (e.estado !== 'borrador') return ok()
    return fallo('La caja está vacía: agregale pedidos antes de confirmarla.')
  }
  revalidarCaja(envioId)
  return ok()
}

// Vuelve una caja aérea a borrador, para corregir una confirmación apurada. Solo mientras
// no pasó nada que dependa de la confirmación: ninguna línea comprada ni con costo real, y
// ningún pago anotado contra la caja. Con algo de eso ya hay plata o mercancía de por medio
// y "en borrador" sería mentira.
export async function volverCajaABorrador(envioId: number): Promise<ActionResult> {
  const r = await db.envio.updateMany({
    where: {
      id: envioId,
      modo: { in: [...MODOS_CON_PEDIDOS] },
      estado: 'confirmado',
      items: { none: { OR: [{ shippingStatus: { not: 'pendiente' } }, { costRealUsd: { not: null } }] } },
      movimientos: { none: {} },
    },
    data: { estado: 'borrador' },
  })
  if (r.count === 0) {
    const e = await db.envio.findUnique({ where: { id: envioId }, select: { estado: true } })
    if (!e) return fallo('Ese envío ya no existe.')
    if (e.estado === 'borrador') return ok()
    return fallo('Ya hay piezas compradas o pagos anotados en esta caja: no puede volver a borrador.')
  }
  revalidarCaja(envioId)
  return ok()
}

function revalidarCaja(envioId: number) {
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/inventario')
  revalidatePath('/contabilidad')
  revalidatePath('/')
}

// "No tienen stock", desde el buscador por SKU de la caja: lo que el proveedor no mandó, repartido
// entre las líneas que llevan ese SKU. `l::<itemId>::<etiquetaPieza>` = unidades ('' en una pieza
// suelta). Son incidencias "sin_enviar" de cada pedido, con las reglas de reportarNoVino, todas o ninguna.
export async function marcarSinStock(envioId: number, formData: FormData): Promise<ActionResult> {
  const porLinea = new Map<number, [string, string][]>()
  for (const [k, v] of formData.entries()) {
    if (typeof v !== 'string' || !k.startsWith('l::') || v.trim() === '' || v.trim() === '0') continue
    const [, id, ...resto] = k.split('::')
    const itemId = Number(id)
    if (!Number.isInteger(itemId)) return fallo('Recargá la página: el formulario quedó viejo.')
    porLinea.set(itemId, [...(porLinea.get(itemId) ?? []), [resto.join('::'), v.trim()]])
  }
  if (porLinea.size === 0) return fallo('Buscá un SKU y poné cuántas no tienen.')
  const enCaja = await db.pedidoItem.count({ where: { id: { in: [...porLinea.keys()] }, envioId } })
  if (enCaja !== porLinea.size) return fallo('Alguna de esas líneas ya no está en esta caja. Recargá la página.')
  const nota = (formData.get('nota') as string)?.trim() || null
  const r = await reportarNoVinoVarios([...porLinea].map(([itemId, crudas]) => ({ itemId, crudas })), nota)
  if (r.ok) revalidarCaja(envioId)
  return r
}

// La tarjeta "Sin stock" de la pestaña Comprar cierra un "no lo mandó" de una línea de esta caja:
// «llegó» (ya la tienen) o «reembolso» (dejaste de esperar; lo que devolvió el proveedor y por
// dónde). Solo pasan esos campos: devolverle al cliente o reponer se hace en el pedido.
export async function resolverSinStock(envioId: number, incidenciaId: number, formData: FormData): Promise<ActionResult> {
  const resolucion = String(formData.get('resolucion') ?? '')
  if (resolucion !== 'llego' && resolucion !== 'reembolso') return fallo('Eso se resuelve desde el pedido.')
  const inc = await db.incidencia.findUnique({ where: { id: incidenciaId }, select: { item: { select: { envioId: true } } } })
  if (inc?.item?.envioId !== envioId) return fallo('Esa pieza ya no está en esta caja. Recargá la página.')
  const fd = new FormData()
  fd.set('resolucion', resolucion)
  if (resolucion === 'reembolso') {
    fd.set('devueltoProveedorUsd', String(formData.get('devueltoProveedorUsd') ?? ''))
    fd.set('metodoDevuelto', String(formData.get('metodoDevuelto') ?? ''))
  }
  const r = await resolverIncidencia(incidenciaId, fd)
  if (r.ok) revalidarCaja(envioId)
  return r
}

// "No vino en este embarque: sigo esperando": la línea que el proveedor no mandó entera sale de la
// caja y queda suelta en su pedido, con su "no lo mandó" abierto, para entrar en la próxima. Solo en
// una caja sin proveedor (99rpm): esa no lleva cuenta de lo pagado, así que el pago puede quedar acá.
// Con proveedor se pasa a otra caja de la misma compra (moverSinStockACaja).
export async function sacarSinStock(envioId: number, itemId: number): Promise<ActionResult> {
  const it = await db.pedidoItem.findUnique({
    where: { id: itemId },
    select: {
      envioId: true, quantity: true, bundleItems: true, pedidoId: true, envio: { select: { supplierId: true } },
      incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { tipo: true, estado: true, cantidad: true, pieza: true } },
    },
  })
  if (!it || it.envioId !== envioId) return fallo('Esa línea ya no está en esta caja. Recargá la página.')
  if (it.envio?.supplierId != null) return fallo('Esta caja tiene proveedor: pasala a otra caja de la misma compra.')
  if (!lineaNoViene(it.quantity, sinEnviarDe(it.incidencias), (it.bundleItems as BundlePiece[] | null) ?? [])) {
    return fallo('De esta línea vino una parte: la caja la lleva. Lo que falta se resuelve en el pedido.')
  }
  // Guardado por caja y etapa: si otra pestaña la movió o la avanzó, no se toca.
  const r = await db.pedidoItem.updateMany({
    where: { id: itemId, envioId, shippingStatus: { in: ['pendiente', 'camino_shoppre'] } },
    data: { envioId: null },
  })
  if (r.count === 0) return fallo('Esa línea ya llegó al depósito o cambió. Recargá la página.')
  revalidarCaja(envioId)
  revalidatePath(`/presupuestos/${it.pedidoId}`)
  return ok()
}

// "Separarla del conjunto": el SKU que no vino sale a una línea propia (pieza suelta: un pedido no
// lleva dos veces el mismo conjunto, el armador identifica la línea por ensamble). La incidencia
// pasa a esa línea, que queda esperando entera: la caja no despacha hasta decidirla, el resto sí viaja.
export async function separarSinStock(envioId: number, incidenciaId: number): Promise<ActionResult> {
  return conErrorDeNegocio(async () => {
    const inc = await db.incidencia.findUnique({
      where: { id: incidenciaId },
      select: { pedidoId: true, itemId: true, pieza: true, cantidad: true, estado: true, tipo: true },
    })
    if (!inc || inc.estado !== 'abierta' || inc.tipo !== 'sin_enviar' || !inc.pieza || inc.itemId == null) {
      throw new ErrorDeNegocio('Eso ya cambió. Recargá la página.')
    }
    const { pedidoId, itemId, pieza } = inc
    await db.$transaction(async tx => {
      await bloquearPedido(tx, pedidoId)
      const it = await tx.pedidoItem.findUnique({ where: { id: itemId }, select: { ...SELECT_LINEA_MOVIBLE, incidencias: { where: { estado: 'abierta', pieza }, select: { id: true } } } })
      if (!it || it.envioId !== envioId || it.ensambleId == null) throw new ErrorDeNegocio('Esa línea ya no está en esta caja. Recargá la página.')
      if (isDelivered(it.shippingStatus)) throw new ErrorDeNegocio('Esa línea ya se entregó.')
      if (it.incidencias.length > 1) throw new ErrorDeNegocio(`«${pieza}» tiene otro problema abierto: resolvelo primero en el pedido.`)
      const piezas = (it.bundleItems as BundlePiece[] | null) ?? []
      const i = piezas.findIndex(p => etiquetaPieza(p) === pieza)
      if (i < 0) throw new ErrorDeNegocio(`«${pieza}» ya no está en este conjunto. Recargá la página.`)
      const resolver = await resolverDePiezas([{ productId: null, quantity: it.quantity, bundleItems: piezas }])
      const ids = piezas.map(resolver)
      const productos = await tx.product.findMany({ where: { id: { in: ids.filter((x): x is number => x != null) } }, select: { id: true, price: true } })
      const precioDe = new Map(productos.map(p => [p.id, Number(p.price)]))
      const plan = planSeparar(
        { quantity: it.quantity, salePrice: Number(it.salePrice), costRealUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null, piezas },
        i, inc.cantidad, p => { const id = ids[piezas.indexOf(p as BundlePiece)]; return id != null ? precioDe.get(id) ?? null : null },
      )
      if (!plan.ok) throw new ErrorDeNegocio(plan.error)
      const productId = ids[i]!
      if (await tx.pedidoItem.count({ where: { pedidoId, productId } }) > 0) {
        throw new ErrorDeNegocio(`El pedido ya tiene «${pieza}» como pieza suelta: no se puede separar en otra línea.`)
      }
      const r = await tx.pedidoItem.updateMany({
        where: { id: itemId, envioId, shippingStatus: it.shippingStatus },
        data: { bundleItems: plan.quedan as unknown as Prisma.InputJsonValue, salePrice: plan.precioQueda, costRealUsd: plan.costoQueda },
      })
      if (r.count === 0) throw new ErrorDeNegocio('Esa línea cambió mientras tanto. Recargá la página.')
      // shortcut: la línea nueva no copia el historial de etapas (PedidoItemEtapa); si se necesita, copiarlo acá.
      const nueva = await tx.pedidoItem.create({
        data: {
          pedidoId, productId, quantity: plan.cantidad, salePrice: plan.precioNuevo, costRealUsd: plan.costoNuevo,
          envioId, supplierId: it.supplierId, origen: it.origen, inbound: it.inbound, isLanded: it.isLanded,
          compradoAt: it.compradoAt, compraId: it.compraId, shippingStatusAt: it.shippingStatusAt,
          // No vino: no pasa de «camino al depósito» aunque el resto del conjunto ya esté ahí.
          shippingStatus: avanzaSinEstar(it.shippingStatus) ? 'camino_shoppre' : it.shippingStatus,
        },
        select: { id: true },
      })
      await tx.incidencia.update({ where: { id: incidenciaId }, data: { itemId: nueva.id, pieza: null, descripcion: piezas[i].nameEs } })
      await registrarEvento(tx, pedidoId, 'incidencia', `«${pieza}» sale del conjunto a su propia línea (sin stock): $${plan.precioNuevo.toFixed(2)} c/u`)
    })
    revalidarCaja(envioId)
    revalidatePath(`/presupuestos/${pedidoId}`)
  })
}

// "Pasarla a esa caja": la línea que el proveedor no mandó entera pasa a otra caja de la misma
// compra, como un presupuesto partido (moverACaja), pero sin atarse a que esta ya haya salido.
export async function moverSinStockACaja(envioId: number, itemId: number, formData: FormData): Promise<ActionResult> {
  const it = await db.pedidoItem.findUnique({
    where: { id: itemId },
    select: {
      envioId: true, quantity: true, bundleItems: true, pedidoId: true,
      incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { tipo: true, estado: true, cantidad: true, pieza: true } },
    },
  })
  if (!it || it.envioId !== envioId) return fallo('Esa línea ya no está en esta caja. Recargá la página.')
  if (!lineaNoViene(it.quantity, sinEnviarDe(it.incidencias), (it.bundleItems as BundlePiece[] | null) ?? [])) {
    return fallo('De esta línea vino una parte: la caja la lleva. Lo que falta se resuelve en el pedido.')
  }
  return moverACaja(envioId, formData, { id: itemId }, it.pedidoId, true)
}

// Mientras la caja está en borrador no es una compra: no se le anota plata ni se mueven sus
// líneas. Devuelve el motivo, o null si se puede.
async function motivoCajaEnBorrador(envioId: number): Promise<string | null> {
  const e = await db.envio.findUnique({ where: { id: envioId }, select: { estado: true } })
  if (!e) return 'Ese envío ya no existe.'
  return e.estado === 'borrador' ? 'La caja está en borrador: confirmala antes de anotar pagos o avanzarla.' : null
}

// El PRESUPUESTO es la unidad NORMAL que entra a un envío: es lo que se le vendió al
// cliente y lo habitual es traerlo entero. Pero no es la unidad obligatoria — la unidad
// real de compra y logística es el PedidoItem (por eso tiene envioId propio), y un
// presupuesto se compra a medias todo el tiempo: unas piezas entran en la caja que sale
// esta semana y el resto espera a la próxima.
//
// Por eso hay dos puertas: esta, que mete todo el presupuesto, y `assignItems`, que mete
// las líneas elegidas. La de acá sigue siendo la primaria y la que ofrecen los botones.
//
// Mete solo lo que está LIBRE (`envioId: null`; lo servido con lo del depósito no viaja). Un presupuesto ya repartido entre cajas
// no se muda entero al agregarlo a una nueva: se le suma únicamente lo que todavía no
// viaja en ninguna, que es lo que falta por traer.
export async function assignPedido(envioId: number, pedidoId: number): Promise<ActionResult> {
  const ids = await db.pedidoItem.findMany({
    where: { pedidoId, envioId: null, desdeStock: false, pedido: { tipo: { not: 'venta' }, status: { not: 'cancelado' } } },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, ids.map(i => i.id))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// Mete en la caja SOLO las líneas elegidas: la alternativa a traer el presupuesto entero,
// para cuando se parte entre dos envíos.
//
// Vuelve a filtrar por `envioId: null` en vez de confiar en los ids que llegan. La pantalla
// desde la que se eligió pudo quedar vieja —otra caja se llevó esa línea mientras tanto— y
// sin el filtro este asigna igual, robándosela a un envío que quizá ya viajó. Es la misma
// razón por la que `assignPedido` filtra: lo asignable es lo que está libre AHORA.
export async function assignItems(envioId: number, itemIds: number[]): Promise<ActionResult> {
  const ids = itemIds.filter(Number.isInteger)
  if (ids.length === 0) return ok()
  const libres = await db.pedidoItem.findMany({
    where: { id: { in: ids }, envioId: null, desdeStock: false, pedido: { tipo: { not: 'venta' }, status: { not: 'cancelado' } } },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, libres.map(i => i.id))
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// Mete líneas en una caja y les copia el proveedor de ESA caja.
//
// La caja es la compra: se le compró a alguien, y todo lo que va adentro se le compró a
// esa misma persona. Antes el proveedor se elegía línea por línea en la tabla, y eso
// permitía el estado imposible de una caja de Garuda con una línea marcada Shoppre — que
// además costeaba mal en silencio, porque esa línea buscaba una tarifa por kilo que para
// esa caja no existe.
//
// De paso se recalcula la ruta: un ítem que estaba "en Shoppre" y pasa a una caja que
// despacha directo se normaliza a la etapa equivalente de su nueva ruta, nunca hacia atrás.
//
// Antes de asignar se valida la caja: ninguna de las tres puertas lo hacía, y con un id viejo
// (una pestaña que quedó abierta) se podía colgar un PedidoItem de una caja marítima —que no
// muestra `items`, así que la línea desaparecía de la vista— o de una ya entregada, y con un
// id que ya no existe saltaba un error de FK sin explicación. Devuelve el motivo en vez de
// tirarlo, porque en producción un throw llega sin texto.
async function asignarAEnvio(envioId: number, itemIds: number[]): Promise<ActionResult> {
  if (itemIds.length === 0) return ok()

  const [envio, items] = await Promise.all([
    db.envio.findUnique({
      where: { id: envioId },
      select: { modo: true, reenvio: true, estado: true, supplier: { select: { id: true, origen: true, inbound: true } } },
    }),
    db.pedidoItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, productId: true, shippingStatus: true, costRealUsd: true, pedido: { select: { tipo: true, status: true, via: true, reenvio: true } } },
    }),
  ])

  if (!envio) return fallo(`La caja #${envioId} ya no existe.`)
  // Una venta del depósito ya salió: no hay nada que comprar ni que viajar.
  if (items.some(i => i.pedido.tipo === 'venta')) {
    return fallo('Una venta del depósito ya está entregada: no viaja en ninguna caja.')
  }
  if (items.some(i => i.pedido.status === 'cancelado')) {
    return fallo('Ese pedido está cancelado: no viaja en ninguna caja.')
  }
  if (!llevaPedidos(envio.modo)) {
    return fallo('Esa caja es marítima: lleva mercancía propia pieza por pieza, no pedidos.')
  }
  // Express con express, y por Miami cada pedido en una caja aérea de su mismo reenvío: es lo que
  // se le cotizó al cliente. Candado real de assignPedido, "agregar todos" y la confirmación.
  for (const it of items) {
    const motivo = motivoViaNoCoincide(it.pedido.via, envio.modo) ?? motivoReenvioNoCoincide(it.pedido, {
      ...envio, despachaProveedor: envio.supplier != null && inboundDe(envio.supplier.origen, envio.supplier.inbound) === 'cotizado',
    })
    if (motivo) return fallo(motivo)
  }
  if (envio.estado === 'entregado') {
    return fallo('Esa caja ya se entregó: no se le pueden agregar pedidos.')
  }
  // Lo que ya se pagó se le compró a alguien que no es esta caja: entrar acá le cambiaría el
  // proveedor y la ruta, y su pago (sin caja) nunca saldaría la deuda que sumaría aquí. Una caja
  // de 99rpm no lleva cuenta con el proveedor, así que esa sí la recibe.
  if (envio.supplier && items.some(i => i.costRealUsd != null)) {
    return fallo('Hay piezas que ya se compraron fuera de esta caja: no pueden pasar a una caja con proveedor.')
  }

  const sup = envio.supplier
  const origen = sup?.origen ?? 'india'
  const inbound = inboundDe(origen, sup?.inbound)

  // isLanded no sale del proveedor sino de la fila explícita (proveedor, producto): el
  // mismo proveedor puede cotizar unas piezas puestas en Venezuela y otras no. Un conjunto no
  // es una pieza y no tiene precio de proveedor propio (cotizan cada pieza, no el ensamble),
  // así que nunca es landed.
  // En express todo sale del depósito de Shoppre en el mismo paquete: nada es landed.
  const piezaIds = envio.modo === 'express' ? [] : items.flatMap(i => (i.productId != null ? [i.productId] : []))
  const landed = sup && piezaIds.length > 0
    ? new Set(
        (await db.supplierPrice.findMany({
          where: { supplierId: sup.id, productId: { in: piezaIds }, isLanded: true },
          select: { productId: true },
        })).map(r => r.productId),
      )
    : new Set<number>()

  await db.$transaction(items.map(it => {
    const esLanded = it.productId != null && landed.has(it.productId)
    return db.pedidoItem.update({
      where: { id: it.id },
      data: {
        envioId,
        supplierId: sup?.id ?? null,
        origen,
        inbound,
        isLanded: esLanded,
        shippingStatus: normalizeToRoute(it.shippingStatus, routeFor(inbound, esLanded, envio.modo, envio.reenvio)),
      },
    })
  }))
  return ok()
}

// Saca de la caja SOLO lo que nunca se compró (estadoLinea 'libre'). Una línea comprada ya tiene
// su pago contado en esta caja y su etapa en el camino: liberarla dejaba la caja "sobrepagada",
// la pieza fuera del inventario en camino y lista para entrar a otra caja con otro proveedor.
// Devuelve cuántas quedaron adentro para que la pantalla lo diga.
export async function removePedido(envioId: number, pedidoId: number): Promise<ActionResult> {
  // En borrador no se pagó ni se movió nada en esta caja (registrarCompra y las etapas lo rechazan):
  // lo que tenga pagado se pagó afuera (p. ej. una pieza que esperaba stock), y vuelve a quedar suelto.
  const caja = await db.envio.findUnique({ where: { id: envioId }, select: { estado: true } })
  await db.pedidoItem.updateMany({
    where: caja?.estado === 'borrador'
      ? { pedidoId, envioId, envio: { estado: 'borrador' } }
      : { pedidoId, envioId, costRealUsd: null, shippingStatus: 'pendiente' },
    data: { envioId: null },
  })
  const quedan = await db.pedidoItem.count({ where: { pedidoId, envioId } })
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return quedan > 0
    ? fallo(`${quedan} línea${quedan === 1 ? '' : 's'} de ese pedido ya se compró o está en camino: se queda${quedan === 1 ? '' : 'n'} en la caja. Lo demás salió.`)
    : ok()
}

// Pasa las líneas de un presupuesto de esta caja a otra, con la etapa, el costo real y el
// proveedor que tienen: para partir una caja que está en el depósito en dos despachos, cada uno
// con sus gastos fijos y su factura. Las reglas están en lib/mover-caja.ts.
//
// Las dos filas de Envio se bloquean (en orden de id, para no cruzarse con otro movimiento al
// revés) y el UPDATE va guardado por la caja y la etapa: si otra pestaña movió algo en el medio,
// no se mueve nada.
export async function moverPedidoACaja(envioId: number, pedidoId: number, formData: FormData): Promise<ActionResult> {
  return moverACaja(envioId, formData, { pedidoId }, pedidoId, false)
}

// `sinEnviar`: es una línea que el proveedor no mandó; no estuvo en el depósito, así que no la
// atan la salida ni el flete de esta caja, y no cambia lo que pesaron las cajas que llegaron.
async function moverACaja(
  envioId: number, formData: FormData, cuales: { pedidoId: number } | { id: number }, pedidoId: number, sinEnviar: boolean,
): Promise<ActionResult> {
  const destinoId = parseInt((formData.get('destinoId') as string) ?? '')
  if (!Number.isInteger(destinoId)) return fallo('Elegí a qué caja pasarlo.')

  return conErrorDeNegocio(async () => {
    await db.$transaction(async tx => {
      const [a, b] = envioId < destinoId ? [envioId, destinoId] : [destinoId, envioId]
      await tx.$queryRaw`SELECT "id" FROM "Envio" WHERE "id" IN (${a}, ${b}) ORDER BY "id" FOR UPDATE`
      const cajas = await tx.envio.findMany({
        where: { id: { in: [envioId, destinoId] } },
        select: {
          id: true, modo: true, estado: true, supplierId: true, reenvio: true, compraDeId: true,
          comisionSalienteUsd: true, comisionEntranteUsd: true,
          supplier: { select: { origen: true, inbound: true } },
          items: { select: { shippingStatus: true, isLanded: true } },
          movimientos: { where: { tipo: 'egreso', categoria: TRAMOS_FLETE.aereo.categoria }, select: { id: true } },
          _count: { select: { partes: true, cajas: { where: { etapa: 'llegada' } } } },
        },
      })
      const leer = (id: number): CajaParaMover => {
        const c = cajas.find(x => x.id === id)
        if (!c) throw new ErrorDeNegocio(id === envioId ? 'Esta caja ya no existe.' : `La caja #${id} ya no existe.`)
        return {
          id: c.id, modo: c.modo, estado: c.estado, supplierId: c.supplierId, reenvio: c.reenvio,
          despachaProveedor: c.supplier != null && inboundDe(c.supplier.origen, c.supplier.inbound) === 'cotizado',
          lineas: c.items,
          fleteAereoPagado: c.movimientos.length > 0,
          compraDeId: c.compraDeId,
          tieneHijas: c._count.partes > 0,
        }
      }
      const origen = leer(envioId)
      const destino = leer(destinoId)
      const motivo = (sinEnviar ? motivoNoMueveSinEnviar : motivoNoMueve)(origen, destino)
      if (motivo) throw new ErrorDeNegocio(motivo)

      const esperadas = await tx.pedidoItem.count({ where: { ...cuales, envioId } })
      if (esperadas === 0) throw new ErrorDeNegocio(sinEnviar ? 'Esa línea ya no está en esta caja. Recargá la página.' : 'Ese presupuesto ya no está en esta caja. Recargá la página.')
      const r = await tx.pedidoItem.updateMany({
        where: sinEnviar
          ? { ...cuales, envioId, shippingStatus: { in: ['pendiente', 'camino_shoppre'] }, incidencias: { some: { estado: 'abierta', tipo: 'sin_enviar' } } }
          : { ...cuales, envioId, OR: [{ isLanded: true }, { shippingStatus: { notIn: [...ETAPAS_FUERA_DEL_DEPOSITO] } }] },
        data: { envioId: destinoId },
      })
      if (r.count !== esperadas) throw new ErrorDeNegocio('Alguna línea cambió de etapa mientras tanto. Recargá la página.')

      const compraDeId = compraTrasMover(origen, destino)
      if (compraDeId !== destino.compraDeId) {
        // Pasa a ser parte de otra compra: el giro fue uno y sus comisiones están anotadas (o se
        // anotan) en la caja raíz. Las de esta caja son 0, un dato: no hubo otro giro. Una que ya
        // tenía algo anotado lo conserva.
        const d = cajas.find(c => c.id === destinoId)!
        await tx.envio.update({
          where: { id: destinoId },
          data: {
            compraDeId,
            ...(d.supplierId != null && d.comisionSalienteUsd == null ? { comisionSalienteUsd: 0 } : {}),
            ...(d.supplierId != null && d.comisionEntranteUsd == null ? { comisionEntranteUsd: 0 } : {}),
          },
        })
      }
      // Las cajas que llegaron al depósito pesan lo que traía la caja entera: desde ahora lo que
      // se factura son las que salen. Con reempaque y sin cajas de salida el costeo queda
      // provisorio hasta cargarlas (ver lib/cajas-envio.ts).
      if (!sinEnviar && (cajas.find(c => c.id === envioId)?._count.cajas ?? 0) > 0) {
        await tx.envio.update({ where: { id: envioId }, data: { reempaque: true } })
      }
    })
  }).then(r => {
    if (r.ok) {
      revalidarCaja(envioId)
      revalidarCaja(destinoId)
      revalidatePath(`/presupuestos/${pedidoId}`)
    }
    return r
  })
}

// Asigna de un tirón los ítems sin envío de todos los pedidos CONFIRMADOS
// (status='pedido'). Nunca toca presupuestos sin aprobar. El stock propio
// (tipo='propio') también tiene status='pedido' desde que se crea, así que se filtra
// aparte según el checkbox del formulario.
export async function assignAllConfirmados(envioId: number, formData: FormData): Promise<ActionResult> {
  const incluirPropio = formData.get('incluirPropio') === 'on'
  // Una caja express se llena solo con presupuestos express, y una aérea con los demás.
  const caja = await db.envio.findUnique({
    where: { id: envioId },
    select: { modo: true, reenvio: true, supplier: { select: { origen: true, inbound: true } } },
  })
  const via = caja?.modo === 'express' ? 'express' : 'normal'
  // Y una aérea, solo con los de su mismo reenvío: si no, un pedido del otro hacía fallar todo.
  // Salvo que despache el proveedor: ahí no hay depósito y el reenvío no aplica.
  const despachaProveedor = caja?.supplier != null && inboundDe(caja.supplier.origen, caja.supplier.inbound) === 'cotizado'
  const reenvio = caja?.modo === 'aereo' && !despachaProveedor ? { reenvio: reenvioDe(caja.reenvio) } : {}

  const ids = await db.pedidoItem.findMany({
    where: {
      envioId: null,
      pedido: {
        status: 'pedido',
        via,
        ...reenvio,
        // Las ventas del depósito ya están entregadas: nunca van a una caja.
        tipo: incluirPropio ? { not: 'venta' } : { notIn: ['propio', 'venta'] },
      },
    },
    select: { id: true },
  })
  const r = await asignarAEnvio(envioId, ids.map(i => i.id))

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  return r
}

// Las cajas como las pesó y midió el transportista o el depósito: lo que llegó y, si hubo
// reempaque, lo que sale. Ver lib/cajas-envio.ts.
//
// Es el único dato físico del envío que NO se puede derivar del catálogo: el catálogo conoce
// la pieza desnuda y la balanza pesa el bulto. Mientras no esté cargado, el costeo es un piso.
//
// El form manda todo junto y esto reemplaza lo guardado, como los trackings. Sin reempaque
// las cajas de salida se borran: lo que se ve es lo que queda. Un número ilegible se RECHAZA
// (vacío reemplaza lo que había, así que guardarlo como vacío borraría un peso cargado).
// Solo lo FÍSICO: el flete facturado tiene su propia acción (guardarFleteReal).
export async function guardarCajas(envioId: number, formData: FormData): Promise<ActionResult> {
  const reempaque = formData.get('reempaque') === '1'
  const filas: (CajaFisica & { etapa: EtapaCaja })[] = []
  for (const etapa of ETAPAS_CAJA) {
    if (etapa === 'salida' && !reempaque) continue
    const campo = (c: CampoCaja) => formData.getAll(`${c}_${etapa}`).map(String)
    const r = leerCajasEtapa(etapa, {
      referencia: campo('referencia'), peso: campo('peso'), largo: campo('largo'), ancho: campo('ancho'), alto: campo('alto'),
    })
    if ('error' in r) return fallo(r.error)
    filas.push(...r.filas.map(f => ({ ...f, etapa })))
  }
  const existe = await db.$transaction(async tx => {
    // El update bloquea la fila del envío: dos guardados cruzados no se mezclan a medias.
    const r = await tx.envio.updateMany({ where: { id: envioId }, data: { reempaque } })
    if (r.count === 0) return false
    await tx.envioCaja.deleteMany({ where: { envioId } })
    if (filas.length > 0) await tx.envioCaja.createMany({ data: filas.map(f => ({ envioId, ...f })) })
    return true
  })
  if (!existe) return fallo('Ese envío ya no existe.')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Lo que cotizó el depósito para ESTA caja: la tarifa ₹/kg (solo reenvío por kilo) y el
// reempaque en ₹ (cualquier caja que pase por un depósito; varía por paquete, por eso no está en
// /config). Mismo trato que saveCostosProveedor: campo ausente no se toca, vacío = no se sabe
// (null), un número ilegible se rechaza en vez de borrar lo cargado. La tarifa solo se escribe
// en cajas 'por_kilo': la guarda va en el WHERE.
export async function guardarCotizacionDeposito(envioId: number, formData: FormData): Promise<ActionResult> {
  const campos = [
    ['tarifaKgInr', 'la tarifa ₹/kg'],
    ['reempaqueInr', 'el reempaque'],
  ] as const
  const data: Partial<Record<(typeof campos)[number][0], number | null>> = {}
  for (const [name, nombre] of campos) {
    if (!formData.has(name)) continue
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) { data[name] = null; continue }
    const v = parseFloat(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) return fallo(`Revisá ${nombre}: no es un número válido.`)
    data[name] = v
  }
  const r = await db.envio.updateMany({
    where: { id: envioId, modo: { in: ['aereo', 'express'] }, ...('tarifaKgInr' in data ? { reenvio: 'por_kilo' } : {}) },
    data,
  })
  if (r.count === 0) return fallo('Esta caja no pasa por ese depósito (o ya no existe).')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Los trackings de la caja, por tramo. Sirven para encontrar la caja cuando el cliente
// pregunta dónde está su pieza. El form manda la lista completa de cada tramo y reemplaza la
// guardada; un tramo vacío queda sin trackings.
//
// El courier llega elegido de la lista de Ship24 (su code); con él el tracking se sigue
// solo (lib/sync-trackings.ts). Texto sin elegir se rechaza salvo «anotar sin seguimiento»
// (courierDeFila): un courier mal escrito no puede quedar sin seguimiento en silencio.
// Reemplazar no borra lo ya consultado: una fila con el mismo tramo, número y courier se
// conserva con su estado y su tracker en Ship24 (crear otro gastaría otro envío del cupo).
export async function guardarTrackings(envioId: number, formData: FormData): Promise<ActionResult> {
  const couriers = await listaCouriers()
  const filas: (FilaTracking & { courierCode: string | null })[] = []
  for (const tramo of TRAMOS_TRACKING) {
    const r = leerTrackingsTramo(
      tramo,
      formData.getAll(`numero_${tramo}`).map(String),
      formData.getAll(`transportista_${tramo}`).map(String),
    )
    if ('error' in r) return fallo(r.error)
    const codigos = formData.getAll(`courier_${tramo}`).map(String)
    const libres = formData.getAll(`libre_${tramo}`).map(String)
    for (const { indice, ...f } of r.filas) {
      // Un código de One Way Cargo es de ellos aunque no se elija courier: se sigue por su cuenta.
      const c = esCodigoOneway(tramo, f.numero)
        ? { courierCode: ONEWAY_CODE, transportista: ONEWAY_NOMBRE }
        : courierDeFila({ codigo: codigos[indice] ?? null, libre: libres[indice] === '1', texto: f.transportista }, couriers)
      if ('error' in c) return fallo(`${TRAMO_TRACKING_META[tramo].label}, tracking ${f.numero}: ${c.error}`)
      filas.push({ ...f, ...c })
    }
  }
  const existe = await db.$transaction(async tx => {
    // Bloquea la caja: dos guardados cruzados no se pisan a medias.
    const caja = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Envio" WHERE "id" = ${envioId} FOR UPDATE`
    if (caja.length === 0) return false
    const actuales = await tx.envioTracking.findMany({
      where: { envioId },
      select: { id: true, tramo: true, numero: true, courierCode: true, transportista: true },
    })
    const conservar = new Map<number, string | null>()
    const crear: typeof filas = []
    for (const f of filas) {
      const a = actuales.find(
        a => !conservar.has(a.id) && a.tramo === f.tramo && a.numero === f.numero && a.courierCode === f.courierCode,
      )
      if (a) conservar.set(a.id, f.transportista)
      else crear.push(f)
    }
    // Primero se borra: un número que cambió de courier choca con el único (caja, tramo, número).
    await tx.envioTracking.deleteMany({ where: { envioId, id: { notIn: [...conservar.keys()] } } })
    for (const a of actuales) {
      const nuevo = conservar.get(a.id)
      if (nuevo !== undefined && nuevo !== a.transportista) {
        await tx.envioTracking.update({ where: { id: a.id }, data: { transportista: nuevo } })
      }
    }
    if (crear.length > 0) await tx.envioTracking.createMany({ data: crear.map(f => ({ envioId, ...f })) })
    return true
  })
  if (!existe) return fallo('Ese envío ya no existe.')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/presupuestos')
  return ok()
}

// "Actualizar ahora": consulta ya, en Ship24 y en One Way Cargo, los trackings de esta caja
// (incluso los que habían dado error, por si se corrigió del lado de ellos). Si todavía no hay
// lista de couriers, la baja: es lo que hace falta para elegirlos la primera vez.
export async function actualizarTrackings(envioId: number): Promise<ActionResult> {
  const apiKey = apiKeyShip24()
  if (!apiKey && !credencialesOneway()) return fallo(`El seguimiento automático está apagado: falta ${ENV_API_KEY} en el servidor.`)
  const caja = await db.envio.findUnique({ where: { id: envioId }, select: { id: true } })
  if (!caja) return fallo('Ese envío ya no existe.')
  let error: string | undefined
  if (apiKey) {
    try {
      await refrescarCouriers(apiKey)
    } catch (e) {
      // Sin lista nueva se sigue con la que hay; si no hay ninguna, el motivo importa.
      if ((await db.trackingCourier.count()) === 0) return fallo(`No se pudo bajar la lista de couriers: ${(e as Error).message}`)
    }
    error = (await sincronizarTrackings({ envioId })).error
  }
  const o = await sincronizarOneway({ envioId })
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/presupuestos')
  if (error || o.error) return fallo([error, o.error].filter(Boolean).join(' '))
  return ok()
}

// ── Flete real: lo que cobraron los transportistas y si ya se les pagó ──────────────────────
// Ver lib/flete-real.ts. El facturado se guarda en la caja; lo pagado sale del libro.

function revalidarFlete(envioId: number) {
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/contabilidad')
}

// El aéreo de una caja que despacha el proveedor (cotizado) no existe: ese tramo es `tramoUsd`
// y se le paga a él dentro del giro. Cargarlo acá se guardaba y no tenía ningún efecto.
async function tramoAplica(envioId: number, tramo: TramoFlete) {
  const envio = await db.envio.findUnique({
    where: { id: envioId },
    select: { modo: true, reenvio: true, supplier: { select: { origen: true, inbound: true } } },
  })
  if (!envio) return { error: 'Ese envío ya no existe.' }
  if (!llevaPedidos(envio.modo)) return { error: 'El flete real se carga en las cajas aéreas.' }
  // El express llega en avión hasta Caracas: Shoppre factura todo el trayecto y no hay naviera.
  // La express por USA sí tiene un segundo tramo: One Way aéreo Miami → Caracas, en la fila 'maritimo'.
  if (envio.modo === 'express' && envio.reenvio !== 'por_kilo' && tramo === 'maritimo') return { error: 'Una caja express no tiene tramo marítimo: Shoppre la lleva hasta Venezuela.' }
  if (tramo === 'aereo' && inboundDe(envio.supplier?.origen, envio.supplier?.inbound) === 'cotizado') {
    return { error: 'En esta caja el tramo a USA lo factura el proveedor: se carga como "Envío + impuestos" en su tarjeta.' }
  }
  return { error: null }
}

export async function guardarFleteReal(envioId: number, tramo: string, formData: FormData): Promise<ActionResult> {
  if (!esTramoFlete(tramo)) return fallo('Ese tramo no existe.')
  const raw = (formData.get('facturado') as string)?.trim()
  let facturado: number | null = null
  if (raw) {
    const v = parseFloat(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) return fallo('Revisá el monto: no es un número válido.')
    facturado = v > 0 ? v : null
  }
  const ap = await tramoAplica(envioId, tramo)
  if (ap.error) return fallo(ap.error)

  await db.envio.update({ where: { id: envioId }, data: { [TRAMOS_FLETE[tramo].columna]: facturado } })
  revalidarFlete(envioId)
  return ok()
}

// Marca un tramo como pagado: un egreso en el libro (llega a /contabilidad sin otro paso),
// con la caja como referencia. Si el flete no estaba cargado, lo que se paga ES lo que
// costó: se guarda también como facturado, en la misma transacción.
//
// El movimiento es aditivo, así que un doble click o dos pestañas pagarían dos veces. Se toma
// el candado de la fila de la caja y se rechaza lo que pase de lo facturado.
export async function pagarFlete(envioId: number, tramo: string, formData: FormData): Promise<ActionResult> {
  if (!esTramoFlete(tramo)) return fallo('Ese tramo no existe.')
  const monto = parseFloat(((formData.get('monto') as string) ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()
  const t = TRAMOS_FLETE[tramo]

  const ap = await tramoAplica(envioId, tramo)
  if (ap.error) return fallo(ap.error)
  const borrador = await motivoCajaEnBorrador(envioId)
  if (borrador) return fallo(borrador)

  return conErrorDeNegocio(async () => {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Envio" WHERE "id" = ${envioId} FOR UPDATE`
      const envio = await tx.envio.findUnique({ where: { id: envioId }, select: { [t.columna]: true } })
      if (!envio) throw new ErrorDeNegocio('Ese envío ya no existe.')
      const facturadoRaw = (envio as Record<string, { toString(): string } | null>)[t.columna]
      const facturado = facturadoRaw != null ? parseFloat(facturadoRaw.toString()) : null

      const pagadoAgg = await tx.movimiento.aggregate({
        where: { envioId, tipo: 'egreso', categoria: t.categoria },
        _sum: { monto: true },
      })
      const pagado = parseFloat((pagadoAgg._sum.monto ?? 0).toString())

      if (facturado == null) {
        await tx.envio.update({ where: { id: envioId }, data: { [t.columna]: monto } })
      } else if (excedeFacturado(facturado, pagado, monto)) {
        throw new ErrorDeNegocio(
          pagado >= facturado - 0.01
            ? `Este tramo ya está pagado ($${pagado.toFixed(2)} de $${facturado.toFixed(2)}).`
            : `Con ese monto se pasa de lo facturado: faltan $${(facturado - pagado).toFixed(2)}.`,
        )
      }

      await tx.movimiento.create({
        data: {
          fecha, tipo: 'egreso', categoria: t.categoria, monto, metodoPago, cuenta: cuentaDeMetodo(metodoPago),
          descripcion: descripcion ?? `${t.titulo} · caja #${envioId}`,
          envioId,
        },
      })
    })
  }).then(r => {
    if (r.ok) revalidarFlete(envioId)
    return r
  })
}

// Deshace UN pago de flete de esta caja. Acotada a la caja y a las categorías de flete: no es
// el borrado genérico del libro, que puede tocar cualquier movimiento.
export async function deshacerPagoFlete(envioId: number, movimientoId: number): Promise<ActionResult> {
  await db.movimiento.deleteMany({
    where: { id: movimientoId, envioId, tipo: 'egreso', categoria: { in: [...CATEGORIAS_FLETE] } },
  })
  revalidarFlete(envioId)
  return ok()
}

// Lo que se le pagó al proveedor de esta caja, aparte de la mercancía: el total que
// facturó por llevarla hasta USA (solo si despacha él, o sea 'cotizado') y lo que costó la
// transferencia con la que se le giró.
//
// Ninguno de los dos se puede derivar. El primero porque el proveedor no tiene tabla de
// tarifas — que es justamente lo que significa 'cotizado' — y sin él sus piezas viajan
// gratis en el cálculo. El segundo porque la comisión no es un rasgo del proveedor sino de
// cada giro: cambia con el monto y con el banco del otro lado, y a la mayoría ni se le
// transfiere. Por eso se anota, no se calcula.
//
// Vacío es "no lo sé todavía" y se guarda como null; un 0 escrito a mano SÍ es un dato
// ("ese giro no costó nada") y se respeta. Las pantallas distinguen los dos casos.
export async function saveCostosProveedor(envioId: number, formData: FormData): Promise<ActionResult> {
  // Un campo AUSENTE del formulario devuelve undefined y Prisma no lo toca; uno presente
  // pero vacío devuelve null y borra lo que hubiera. La diferencia importa porque las dos
  // rutas usan esta misma acción con formularios distintos: el marítimo no pregunta por el
  // tramo a USA (no existe), y sin esta distinción guardarlo desde ahí lo borraría.
  //
  // Un número ilegible o negativo se rechaza: guardarlo como vacío (lo que se hacía) borraba
  // en silencio un monto ya cargado, y en este modelo vacío es "no lo sé", no un error de tipeo.
  const campos = [
    ['tramoUsd', 'el envío + impuestos'],
    ['comisionSalienteUsd', 'la comisión saliente'],
    ['comisionEntranteUsd', 'la comisión entrante'],
  ] as const
  const data: Partial<Record<(typeof campos)[number][0], number | null>> = {}
  for (const [name, nombre] of campos) {
    if (!formData.has(name)) continue
    const raw = (formData.get(name) as string)?.trim()
    if (!raw) { data[name] = null; continue }
    const v = parseFloat(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) return fallo(`Revisá ${nombre}: no es un número válido.`)
    data[name] = v
  }

  // Cada punta del giro se guarda aparte: se conocen en momentos distintos y un vacío sigue
  // significando "no lo sé", no cero.
  const r = await db.envio.updateMany({ where: { id: envioId }, data })
  if (r.count === 0) return fallo('Ese envío ya no existe.')
  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Anota un egreso real (plata que salió de la cuenta) contra esta caja: pago de
// mercancía, comisión de giro, flete. Es aditivo — no toca tramoUsd/comisionSalienteUsd/
// comisionEntranteUsd (esos son lo FACTURADO, se siguen cargando aparte con
// saveCostosProveedor). "Pagado"/"pendiente" de este envío se calculan en vivo sumando
// estos movimientos (ver lib/movimientos.ts: cuentasPorPagar).
export async function registrarPagoProveedor(envioId: number, formData: FormData): Promise<ActionResult> {
  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')
  const categoria = (formData.get('categoria') as string)?.trim() || 'pago_proveedor'
  // Esto siempre es un egreso: una categoría de ingreso (o inventada) desde un POST armado
  // quedaría anotada como egreso con un nombre que no le corresponde.
  if (!(CATEGORIAS_EGRESO as readonly string[]).includes(categoria)) return fallo('Esa categoría no es un egreso.')
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  const envio = await db.envio.findUnique({ where: { id: envioId }, select: { supplierId: true, estado: true } })
  if (!envio) return fallo('Ese envío ya no existe.')
  if (envio.estado === 'borrador') return fallo('La caja está en borrador: confirmala antes de anotar pagos.')

  await db.movimiento.create({
    data: { fecha, tipo: 'egreso', categoria, monto, metodoPago, cuenta: cuentaDeMetodo(metodoPago), descripcion, envioId, supplierId: envio.supplierId },
  })

  revalidatePath('/envios')
  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/contabilidad')
  return ok()
}

export interface CambioItem {
  id: number
  shippingStatus: string
}

// Guarda en LOTE el estado de transporte de los ítems del envío.
//
// La llama la tabla (client component) con los cambios ya calculados: sirve igual para un
// select suelto que para "aplicar a todo el presupuesto", porque en los dos casos el
// cliente sabe exactamente qué filas cambió. Un solo viaje a la DB por tanda.
//
// El PROVEEDOR ya no se toca acá: es de la caja, y las líneas lo heredaron al entrar (ver
// asignarAEnvio). Cuando se elegía por línea, una caja de Garuda podía tener una línea
// marcada Shoppre — un estado imposible que además costeaba mal sin avisar.
//
// Se parte de los ítems que REALMENTE están en este envío, así un id ajeno no puede tocar
// nada, y el estado se normaliza a la ruta de cada uno: un ítem que despacha el proveedor
// no puede quedar "en Shoppre".
//
// Una línea de cliente llega hasta "Recibido": se entrega desde su pedido (confirmarEntrega), que
// es donde se cobra el saldo (ver seEntregaDesdeElPedido). Sacarla de entregado sí se puede acá,
// para corregir un error. Una línea con un problema abierto (dañada, incompleta…) no se entrega, y
// una "no disponible" no se compra; esas no se saltean. Cada cambio de etapa deja su fila en
// `PedidoItemEtapa`, de donde salen los tiempos reales (lib/etapas.ts).
export async function saveItemChanges(envioId: number, cambios: CambioItem[]): Promise<ActionResult> {
  if (cambios.length === 0) return ok()

  // Una caja en borrador no es una compra todavía: sus líneas no se compran ni viajan.
  const borrador = await motivoCajaEnBorrador(envioId)
  if (borrador) return fallo(borrador)

  const [items, conSinEnviar] = await Promise.all([
    db.pedidoItem.findMany({
      where: { envioId, id: { in: cambios.map(c => c.id) } },
      select: {
        id: true, shippingStatus: true, origen: true, inbound: true, isLanded: true,
        productId: true, quantity: true, bundleItems: true,
        pedido: { select: { id: true, tipo: true, status: true, clientName: true } },
        incidencias: { select: { tipo: true, estado: true } },
        envio: { select: { modo: true, reenvio: true } },
      },
    }),
    // Lo que el proveedor no mandó entero espera en la caja sin estar en el depósito (lib/sin-stock.ts).
    db.pedidoItem.findMany({
      where: { envioId, incidencias: { some: { estado: 'abierta', tipo: 'sin_enviar' } } },
      select: {
        id: true, pedidoId: true, quantity: true, bundleItems: true,
        product: { select: { nameEs: true } }, ensamble: { select: { nameEs: true, nameEn: true } },
        incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { tipo: true, estado: true, cantidad: true, pieza: true } },
      },
    }),
  ])
  if (items.length === 0) return ok()
  const noVienen = conSinEnviar.filter(l => lineaNoViene(l.quantity, sinEnviarDe(l.incidencias), (l.bundleItems as BundlePiece[] | null) ?? []))
  const noViene = new Set(noVienen.map(l => l.id))
  let frenadas = 0

  const pedido = new Map(cambios.map(c => [c.id, c]))

  // Cada fila lleva el estado que LEYÓ (`desde`) y el que quiere (`hacia`). El UPDATE solo
  // toca la fila si sigue en `desde`: si dos requests llevan la misma línea a 'entregado'
  // (doble tanda, dos pestañas), la segunda espera el candado de la fila, la encuentra ya
  // movida y no actualiza nada — y con ella no se acredita el stock por segunda vez.
  //
  // Stock propio: lo comercial (tipo='cliente') se entrega a un cliente, nunca pasa a ser
  // stock. El signo sigue la TRANSICIÓN de "entregado" (no un flag aparte guardado en otro
  // lado), así que ida y vuelta del estado nunca duplica ni pierde el crédito: si el ítem ya
  // estaba entregado antes de este cambio, ya se sumó, y si deja de estarlo hay que restarlo.
  const filas: FilaEtapa[] = []
  const conStock: (typeof items)[number][] = []
  for (const it of items) {
    const c = pedido.get(it.id)
    if (!c) continue

    const destino = isValidStatus(c.shippingStatus) ? c.shippingStatus : it.shippingStatus
    const ruta = routeFor(inboundDe(it.origen, it.inbound), it.isLanded, it.envio?.modo, it.envio?.reenvio)
    const status = normalizeToRoute(destino, ruta)
    if (status === it.shippingStatus) continue
    // No está en el depósito: avanza recién cuando se marca que llegó. "Avanzar todo" la saltea.
    if (noViene.has(it.id) && avanzaSinEstar(status)) { frenadas++; continue }

    // Un pedido cancelado ya no viaja: sus piezas compradas pasaron a stock propio y el resto salió de la caja.
    if (it.pedido.status === 'cancelado') {
      return fallo(`El pedido #${it.pedido.id} (${it.pedido.clientName}) está cancelado: sus líneas no se mueven.`)
    }
    if (isPending(it.shippingStatus) && !isPending(status) && bloqueaCompra(it.incidencias)) {
      return fallo(`Una pieza del pedido #${it.pedido.id} está marcada como no disponible: resolvé el problema antes de comprarla.`)
    }
    if (isDelivered(status) && bloqueaEntrega(it.incidencias)) {
      return fallo(`Una pieza del pedido #${it.pedido.id} tiene un problema sin resolver (dañada, incompleta…): resolvelo antes de entregarla.`)
    }
    if (isDelivered(status) && seEntregaDesdeElPedido(it.pedido.tipo)) {
      return fallo(
        `Lo del pedido #${it.pedido.id} (${it.pedido.clientName}) se entrega desde el pedido, con "Confirmar entrega": ` +
        `ahí se cobra el saldo. Desde la caja llega hasta "Recibido".`,
      )
    }

    let signo = 0
    if (it.pedido.tipo === 'propio') {
      const eraEntregado = isDelivered(it.shippingStatus)
      const quedaEntregado = isDelivered(status)
      if (eraEntregado !== quedaEntregado) signo = quedaEntregado ? 1 : -1
    }
    if (signo !== 0) conStock.push(it)
    filas.push({ id: it.id, desde: it.shippingStatus, hacia: status, signo })
  }
  if (filas.length === 0) {
    return frenadas > 0
      ? fallo('El proveedor no mandó esa pieza: no está en el depósito. En la pestaña Comprar marcá que llegó antes de moverla.')
      : ok()
  }
  const noDespacha = motivoNoDespacha(filas, noVienen.map(l => ({
    nombre: l.product?.nameEs ?? (l.ensamble ? nombreEnsamble(l.ensamble) : 'una línea'), pedidoId: l.pedidoId,
  })))
  if (noDespacha) return fallo(noDespacha)

  // Qué piezas del catálogo mueve cada línea: la pieza suelta, o las piezas del conjunto (ver
  // lib/stock-piezas). Si alguna pieza de un conjunto no se puede identificar no se entrega
  // nada: sumar el conjunto a medias dejaría el stock mal sin que nadie lo note.
  const lineas = conStock.map(it => ({ ...it, bundleItems: it.bundleItems as BundlePiece[] | null }))
  const resolver = await resolverDePiezas(lineas)
  const piezas: PiezaEtapa[] = []
  const faltan: BundlePiece[] = []
  for (const l of lineas) {
    const r = piezasDeLinea(l, resolver)
    faltan.push(...r.faltan)
    for (const p of r.piezas) piezas.push({ itemId: l.id, ...p })
  }
  if (faltan.length > 0) {
    return fallo(
      `No se puede mover al stock: ${faltan.length === 1 ? 'una pieza del conjunto no está' : `${faltan.length} piezas del conjunto no están`} ` +
      `en el catálogo con un código único (${listarFaltantes(faltan)}). Cargala como producto y probá de nuevo.`,
    )
  }

  const r = await conErrorDeNegocio(() => moverEtapas(envioId, filas, piezas))
  if (!r.ok) return r

  revalidatePath(`/envios/${envioId}`)
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  revalidatePath('/inventario')
  revalidatePath('/resultados')
  if (piezas.length > 0) {
    revalidatePath('/contabilidad')
    revalidatePath('/products')
    revalidatePath('/')
  }
  return ok()
}

export async function deleteEnvio(id: number): Promise<ActionResult> {
  const envio = await db.envio.findUnique({
    where: { id },
    select: {
      estado: true,
      _count: {
        select: {
          movimientos: true,
          items: { where: { OR: [{ costRealUsd: { not: null } }, { shippingStatus: { not: 'pendiente' } }] } },
        },
      },
    },
  })
  // Ya no existe (otra pestaña, un reintento): lo que se quería ya está logrado.
  if (!envio) redirect('/envios')
  // Una caja 'entregado' ya sumó su contenido a Product.stock: borrarla sin deshacer esa
  // recepción (ver deshacerRecepcion) dejaría el stock arriba sin ningún registro que lo
  // explique. El botón ya se esconde en esa vista; esto es el mismo corte del lado server.
  if (envio.estado === 'entregado') return fallo('La caja ya se recibió: deshacé la recepción antes de borrarla.')
  // Con pagos registrados, borrarla dejaría esos movimientos sin caja (onDelete: SetNull) y
  // la deuda con el proveedor saldría de "cuentas por pagar" sin que nadie la haya saldado.
  if (envio._count.movimientos > 0) {
    return fallo(`Tiene ${envio._count.movimientos} movimiento${envio._count.movimientos === 1 ? '' : 's'} de caja registrado${envio._count.movimientos === 1 ? '' : 's'}: borrarla los dejaría sin caja.`)
  }
  // Lo comprado o en camino viaja en ESTA caja: borrarla lo soltaría a medio camino (ver removePedido).
  // En borrador no: nada se pagó ni se movió acá, y lo pagado afuera vuelve a quedar suelto.
  if (envio.estado !== 'borrador' && envio._count.items > 0) {
    return fallo(`Tiene ${envio._count.items} línea${envio._count.items === 1 ? '' : 's'} ya comprada${envio._count.items === 1 ? '' : 's'} o en camino: no se puede borrar.`)
  }

  // Los ítems quedan liberados (envioId -> null) por onDelete: SetNull.
  await db.envio.deleteMany({ where: { id } })
  revalidatePath('/envios')
  revalidatePath('/presupuestos')
  redirect('/envios')
}
