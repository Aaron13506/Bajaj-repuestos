'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'
import { findOrCreateCliente, revalidateClientes } from '@/lib/clientes'
import { isDelivered } from '@/lib/shipping-status'
import { ok, fallo, conErrorDeNegocio, ErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { motivoNoEliminable } from '@/lib/pedido-eliminable'
import { isForeignKeyViolation } from '@/lib/prisma-errors'
import { bloquearPedido, descontarIngresosPedido, registrarIngresoPedido } from '@/lib/movimientos'

interface ItemInput {
  productId: number
  quantity: number
  salePrice: number
  bundleItems?: BundlePiece[] | null
}

/**
 * Lee y valida las líneas que manda el armador.
 *
 * Era un `JSON.parse(formData.get('items') as string)` pelado: un payload cortado tiraba
 * un SyntaxError crudo, y una cantidad en 0 o un precio negativo entraban tal cual a un
 * documento comercial. También rechaza el mismo producto dos veces, porque PedidoItem
 * tiene `@@unique([pedidoId, productId])`: pasaba como un P2002 ilegible, y fusionar las
 * cantidades en silencio sería peor —hay dos precios de venta y ninguno es más cierto
 * que el otro.
 */
function parseItems(formData: FormData): ItemInput[] {
  let crudo: unknown
  try {
    crudo = JSON.parse((formData.get('items') as string) ?? '')
  } catch {
    throw new ErrorDeNegocio('No se pudieron leer las líneas del presupuesto (JSON inválido).')
  }
  if (!Array.isArray(crudo)) throw new ErrorDeNegocio('Las líneas del presupuesto llegaron en un formato inesperado.')

  const vistos = new Set<number>()
  return crudo.map((raw, i): ItemInput => {
    const it = raw as Partial<ItemInput>
    const productId = Number(it.productId)
    const quantity = Number(it.quantity)
    const salePrice = Number(it.salePrice)

    if (!Number.isInteger(productId) || productId <= 0) throw new ErrorDeNegocio(`Línea ${i + 1}: producto inválido.`)
    if (!Number.isInteger(quantity) || quantity < 1) throw new ErrorDeNegocio(`Línea ${i + 1}: la cantidad tiene que ser un entero ≥ 1.`)
    if (!Number.isFinite(salePrice) || salePrice < 0) throw new ErrorDeNegocio(`Línea ${i + 1}: el precio de venta no es un número válido.`)
    if (vistos.has(productId)) throw new ErrorDeNegocio(`El producto ${productId} aparece dos veces en el presupuesto.`)
    vistos.add(productId)

    return {
      productId,
      quantity,
      salePrice,
      bundleItems: it.bundleItems && it.bundleItems.length > 0 ? it.bundleItems : null,
    }
  })
}

// Un conjunto vendido a precio único guarda el snapshot de sus piezas; una pieza suelta
// guarda NULL. En un update hay que decirlo explícito (DbNull), porque `undefined` en
// Prisma significa "no toques la columna" y dejaría pegado el snapshot de un conjunto que
// dejó de serlo.
function snapshotBundle(items: BundlePiece[] | null | undefined) {
  return items && items.length > 0
    ? (items as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull
}

/**
 * Corta si alguna línea es una pieza que Bajaj dejó de fabricar.
 *
 * El armador ya las bloquea en pantalla, pero eso no alcanza: la pieza pudo marcarse
 * DESPUÉS de que el presupuesto se guardó, y al reabrirlo para tocar una cantidad se
 * reescribiría igual. Es la misma razón por la que el embarque marítimo corta en
 * `sincronizarLineas` — el bloqueo es una regla del negocio, no un detalle de la pantalla.
 *
 * Acá pesa más que en un embarque: un embarque es mercancía propia y se saca sin costo,
 * un presupuesto es un compromiso con un cliente y suele tener el 50% cobrado de seña.
 *
 * Tira un `ErrorDeNegocio`, que `createPresupuesto`/`updatePresupuesto` devuelven como
 * `{ ok: false, error }`: un `Error` pelado llega al navegador en producción como "An error
 * occurred in the Server Components render", sin el texto. Es el último cerrojo, no la vía
 * normal de enterarse: lo normal es verlas tachadas en el armador. Que falle es preferible a
 * guardar la promesa.
 */
async function bloquearDescontinuadas(items: { productId: number }[]) {
  const ids = [...new Set(items.map(i => i.productId))]
  if (ids.length === 0) return
  const nls = await db.product.findMany({
    where: { id: { in: ids }, discontinuedAt: { not: null } },
    select: { nameEs: true, bajajCode: true },
  })
  if (nls.length === 0) return
  const lista = nls.map(p => p.bajajCode ?? p.nameEs).join(', ')
  const una = nls.length === 1
  throw new ErrorDeNegocio(
    `No se puede guardar: ${nls.length} pieza${una ? '' : 's'} descontinuada${una ? '' : 's'} (${lista}). ` +
    `Bajaj no ${una ? 'la fabrica' : 'las fabrica'} más y no ${una ? 'la consigue' : 'las consigue'} ningún ` +
    `proveedor, así que cotizar${una ? 'la' : 'las'} es prometer algo que no se va a poder comprar. ` +
    `Sacá${una ? 'la' : 'las'} del presupuesto.`
  )
}

// Resuelve el Cliente elegido en el builder: existente (clienteId) o uno nuevo
// creado al vuelo (nuevoClienteNombre). Solo aplica a tipo 'cliente' — el stock
// propio (tipo 'propio') no lleva Cliente, sigue con clientName de texto libre.
async function resolveCliente(formData: FormData) {
  const clienteIdRaw = (formData.get('clienteId') as string) ?? ''
  if (clienteIdRaw === '__new__') {
    const nombre = (formData.get('nuevoClienteNombre') as string)?.trim()
    if (!nombre) return null
    const telefono = (formData.get('nuevoClienteTelefono') as string)?.trim() || null
    const { cliente } = await findOrCreateCliente(nombre, telefono)
    return cliente
  }
  const id = parseInt(clienteIdRaw)
  if (isNaN(id)) return null
  return db.cliente.findUnique({ where: { id } })
}

// Devuelve `ActionResult` (y no `void`): en el éxito hace `redirect`, así que lo único que
// el cliente llega a recibir es el motivo de un rechazo — antes un `return` mudo (sin cliente,
// sin líneas) era indistinguible de guardar y el armador quedaba trabado en "Guardando…".
export async function createPresupuesto(formData: FormData): Promise<ActionResult> {
  return conErrorDeNegocio(() => crearPresupuesto(formData))
}

async function crearPresupuesto(formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const tipo = (formData.get('tipo') as string) === 'propio' ? 'propio' : 'cliente'
  const items = parseItems(formData)

  if (items.length === 0) throw new ErrorDeNegocio('Agregá al menos una pieza.')
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) throw new ErrorDeNegocio('Ponele un nombre a este stock propio.')
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) throw new ErrorDeNegocio('Elegí un cliente, o escribí el nombre del nuevo.')
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  // El stock propio es una compra definida para revender: entra directo como
  // pedido (no necesita aprobación ni adelanto). El de cliente arranca como presupuesto.
  const status = tipo === 'propio' ? 'pedido' : 'presupuesto'

  const pedido = await db.pedido.create({
    data: {
      clientName,
      clienteId,
      notas,
      tipo,
      status,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          bundleItems: snapshotBundle(i.bundleItems),
        })),
      },
    },
  })

  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect(`/presupuestos/${pedido.id}`)
}

/**
 * Guarda los cambios de un presupuesto SIN tocar el eje logístico de las líneas que
 * sobreviven a la edición.
 *
 * Antes eran dos statements sueltos: `deleteMany` de todos los ítems y después un
 * `create` de la lista nueva. Dos problemas, y el segundo es el caro:
 *
 * 1. NO ERA ATÓMICO. Si el `create` fallaba —un producto borrado, un P2002, un corte de
 *    red a us-west-2— los ítems ya estaban borrados y no volvían. Un presupuesto vacío,
 *    de un documento que suele tener el 50% cobrado de seña.
 *
 * 2. BORRABA EL EJE LOGÍSTICO EN CADA EDICIÓN. PedidoItem no es solo precio y cantidad:
 *    es la unidad de compra (envioId, shippingStatus, shippingStatusAt, supplierId,
 *    origen, inbound, isLanded, costRealUsd, compradoAt). Recrear la línea le ponía a
 *    todo eso el default. Tocabas una cantidad y la pieza perdía en qué caja viajaba y
 *    en qué etapa estaba. Es alcanzable hoy: el stock propio nace en status 'pedido',
 *    se edita siempre, y es justo lo que se asigna a un embarque.
 *
 * Ahora se hace por diferencia: se borra lo que el usuario sacó, se actualiza lo que
 * sigue —solo cantidad, precio y snapshot— y se crea lo que agregó. Todo en UN
 * $transaction por lotes (no interactivo) para que sea un viaje y no uno por línea:
 * con 30 líneas contra Supabase, la versión interactiva se comía el timeout de 5 s.
 */
export async function updatePresupuesto(id: number, formData: FormData): Promise<ActionResult> {
  return conErrorDeNegocio(() => editarPresupuesto(id, formData))
}

async function editarPresupuesto(id: number, formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const existing = await db.pedido.findUnique({
    where: { id },
    select: { tipo: true, status: true, items: { select: { productId: true, quantity: true, shippingStatus: true } } },
  })
  if (!existing) throw new ErrorDeNegocio(`El presupuesto #${id} ya no existe.`)

  // El mismo candado que la página (edit/page.tsx). Estaba SOLO en la página, así que una
  // pestaña vieja o un POST directo editaba un pedido de cliente ya confirmado. El resto
  // de las acciones del repo ya revalidan su guard del lado del server (ver
  // esBorradorMaritimo en envios/linea-actions); esta se había quedado afuera.
  const editable = existing.status === 'presupuesto' || existing.tipo === 'propio'
  if (!editable) {
    throw new ErrorDeNegocio('Este pedido ya está confirmado y no se puede editar.')
  }

  const items = parseItems(formData)
  if (items.length === 0) throw new ErrorDeNegocio('Agregá al menos una pieza.')
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (existing.tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) throw new ErrorDeNegocio('Ponele un nombre a este stock propio.')
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) throw new ErrorDeNegocio('Elegí un cliente, o escribí el nombre del nuevo.')
    clientName = cliente.nombre
    clienteId = cliente.id
  }

  const antes = new Set(existing.items.map(i => i.productId))
  const ahora = new Set(items.map(i => i.productId))
  const aBorrar = [...antes].filter(pid => !ahora.has(pid))

  const ops: Prisma.PrismaPromise<unknown>[] = []

  if (aBorrar.length > 0) {
    ops.push(db.pedidoItem.deleteMany({ where: { pedidoId: id, productId: { in: aBorrar } } }))
  }

  for (const i of items.filter(i => antes.has(i.productId))) {
    ops.push(db.pedidoItem.update({
      where: { pedidoId_productId: { pedidoId: id, productId: i.productId } },
      // Solo lo comercial. Todo lo logístico queda como estaba, que es el punto.
      data: { quantity: i.quantity, salePrice: i.salePrice, bundleItems: snapshotBundle(i.bundleItems) },
    }))
  }

  // Stock propio: una línea ya 'entregado' SUMÓ su cantidad a Product.stock cuando llegó (ver
  // saveItemChanges). Si acá se cambia la cantidad o se saca la línea, el stock tiene que
  // acompañarlo, o queda describiendo una entrega que ya no es la del documento: se edita la
  // cantidad de 10 a 6 y el depósito sigue diciendo que entraron 10. El ajuste va en la misma
  // transacción que la edición. Las líneas que todavía no llegaron no tocan stock.
  const ajusteStock = new Map<number, number>()
  if (existing.tipo === 'propio') {
    const cantidadAhora = new Map(items.map(i => [i.productId, i.quantity]))
    for (const it of existing.items) {
      if (!isDelivered(it.shippingStatus)) continue
      const delta = (cantidadAhora.get(it.productId) ?? 0) - it.quantity
      if (delta !== 0) ajusteStock.set(it.productId, delta)
    }
  }
  if (ajusteStock.size > 0) {
    // Bajar la cantidad entregada resta del depósito: si eso ya se vendió, el stock quedaría
    // en negativo, o sea, afirmaría que se vendió lo que no existía.
    const bajan = [...ajusteStock].filter(([, d]) => d < 0).map(([pid]) => pid)
    if (bajan.length > 0) {
      const prods = await db.product.findMany({
        where: { id: { in: bajan } },
        select: { id: true, stock: true, nameEs: true, bajajCode: true },
      })
      const corto = prods.filter(pr => pr.stock + ajusteStock.get(pr.id)! < 0)
      if (corto.length > 0) {
        const lista = corto.slice(0, 3).map(pr => pr.bajajCode ?? pr.nameEs).join(', ')
        throw new ErrorDeNegocio(
          `No se puede reducir lo ya entregado: el stock de ${lista}${corto.length > 3 ? '…' : ''} no alcanza ` +
          `para descontarlo (se vendió o se ajustó a mano). Corregí ese stock primero.`,
        )
      }
    }
    for (const [productId, delta] of ajusteStock) {
      ops.push(db.product.update({ where: { id: productId }, data: { stock: { increment: delta } } }))
    }
  }

  const nuevos = items.filter(i => !antes.has(i.productId))
  if (nuevos.length > 0) {
    ops.push(db.pedidoItem.createMany({
      data: nuevos.map(i => ({
        pedidoId: id,
        productId: i.productId,
        quantity: i.quantity,
        salePrice: i.salePrice,
        bundleItems: snapshotBundle(i.bundleItems),
      })),
    }))
  }

  ops.push(db.pedido.update({ where: { id }, data: { clientName, clienteId, notas } }))

  await db.$transaction(ops)

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidateClientes()
  if (ajusteStock.size > 0) {
    revalidatePath('/contabilidad')
    revalidatePath('/products')
    revalidatePath('/')
  }
  redirect(`/presupuestos/${id}`)
}

// Aprueba un presupuesto (status -> 'pedido') registrando el adelanto: monto,
// método de pago y fecha. Reutilizable para editar el adelanto de un pedido ya
// confirmado (el status ya es 'pedido' y solo se actualizan los campos del adelanto).
//
// depositUsd es una CACHÉ de "total recibido hasta ahora" (ver Pedido en el schema) y el
// libro es la fuente de verdad: las dos tienen que moverse juntas.
//   · Un AUMENTO es plata que entró de verdad: crea un Movimiento por el delta, no por el
//     total.
//   · Una BAJA es la corrección de un dato (se cargó $1000 y era $100): no salió plata, así
//     que se corrige el libro sacando ese monto de los ingresos del pedido — si no, el
//     depósito bajaba pero el Movimiento de $1000 seguía sumando al saldo de caja, inflado
//     para siempre. Una devolución real al cliente es otro hecho: va como egreso aparte.
//
// Todo corre bajo el cerrojo de la fila del pedido y lee el depósito DENTRO de la
// transacción: la lectura de antes estaba afuera, y un cobro registrado entre medio hacía
// que el delta se calculara contra un número viejo. De paso, un doble envío de la misma
// edición ve el resultado del primero y no anota nada de más.
export async function aprobarPedido(id: number, formData: FormData): Promise<ActionResult> {
  const rawDeposit = (formData.get('depositUsd') as string)?.trim()
  const paymentMethod = (formData.get('paymentMethod') as string)?.trim() || null
  const rawDate = (formData.get('depositAt') as string)?.trim()
  // El input date da 'YYYY-MM-DD'; se ancla a mediodía para evitar corrimientos de zona horaria.
  const depositAt = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  // Vacío = "no se cobró nada"; un número ilegible o negativo no es ninguna de las dos cosas
  // y se rechaza en vez de guardarse como null.
  let nuevoDeposito: number | null = null
  if (rawDeposit) {
    const v = parseFloat(rawDeposit)
    if (!Number.isFinite(v) || v < 0) return fallo('El adelanto tiene que ser un monto válido (0 o más).')
    nuevoDeposito = v
  }

  const resultado = await db.$transaction(async (tx): Promise<ActionResult> => {
    const actual = await bloquearPedido(tx, id)
    if (!actual) return fallo(`El pedido #${id} no existe.`)

    const anterior = actual.depositUsd
    // Dejar el campo vacío en un pedido que ya cobró borraría el depósito sin tocar el libro
    // (o, ahora, vaciaría los ingresos). Casi siempre es un descuido: para dejarlo en cero se
    // escribe 0.
    if (nuevoDeposito == null && anterior > 0.01) {
      return fallo(`Este pedido ya tiene $${anterior.toFixed(2)} cobrados. Si querés dejarlo en cero, escribí 0.`)
    }

    const delta = (nuevoDeposito ?? 0) - anterior
    const eraPresupuesto = actual.status === 'presupuesto'

    await tx.pedido.update({
      where: { id },
      data: { status: 'pedido', depositUsd: nuevoDeposito, paymentMethod, depositAt },
    })
    if (delta > 0.01) {
      await tx.movimiento.create({
        data: {
          fecha: depositAt,
          tipo: 'ingreso',
          categoria: eraPresupuesto ? 'adelanto_cliente' : 'pago_cliente',
          monto: delta,
          metodoPago: paymentMethod,
          pedidoId: id,
        },
      })
    } else if (delta < -0.01) {
      await descontarIngresosPedido(tx, id, -delta)
    }
    return ok()
  }, { maxWait: 10_000, timeout: 20_000 })

  if (!resultado.ok) return resultado

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  revalidatePath('/contabilidad')
  // El adelanto y el pase a 'pedido' mueven los totales del cliente.
  revalidateClientes()
  return ok()
}

// Anota un pago adicional (liquidación, cuota) sin tocar el status ni el método/fecha del
// adelanto original. Mismo mecanismo que el delta de aprobarPedido: suma a la caché
// depositUsd y deja un Movimiento por el monto exacto que entró (ver registrarIngresoPedido,
// que suma con un UPDATE atómico y no leyendo el depósito para reescribirlo).
export async function registrarPagoPedido(pedidoId: number, formData: FormData): Promise<ActionResult> {
  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  try {
    await db.$transaction(tx =>
      registrarIngresoPedido(tx, { pedidoId, monto, categoria: 'pago_cliente', fecha, metodoPago, descripcion }),
    )
  } catch (e) {
    // El pedido se borró desde otra pestaña: el movimiento no tiene a quién colgarse.
    if (isForeignKeyViolation(e)) return fallo('Ese pedido ya no existe. Recargá la página.')
    throw e
  }

  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${pedidoId}`)
  revalidatePath('/contabilidad')
  revalidateClientes()
  return ok()
}

// Solo se borra lo que nunca tuvo consecuencias (ver motivoNoEliminable): un pedido con
// cobros, compras o piezas en una caja dejaría el libro y las cajas con huecos. La
// pantalla ya no ofrece el botón en esos casos; este es el cerrojo del lado del server, y
// devuelve el motivo (`DeleteButton` lo muestra) en vez de tirarlo: en producción un throw
// llega sin el texto.
export async function deletePresupuesto(id: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => borrarPresupuesto(id))
  if (!r.ok) return r
  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect('/presupuestos')
}

async function borrarPresupuesto(id: number) {
  await db.$transaction(async tx => {
    const p = await tx.pedido.findUnique({
      where: { id },
      select: {
        tipo: true,
        status: true,
        depositUsd: true,
        items: { select: { envioId: true, shippingStatus: true, costRealUsd: true } },
        _count: { select: { movimientos: true } },
      },
    })
    if (!p) return // ya lo había borrado otra request

    const motivo = motivoNoEliminable({ ...p, movimientos: p._count.movimientos })
    if (motivo) throw new ErrorDeNegocio(`No se puede borrar: ${motivo}`)

    await tx.pedido.delete({ where: { id } })
  })
}
