'use server'

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type BundlePiece } from '@/lib/bundle'
import { findOrCreateCliente, revalidateClientes } from '@/lib/clientes'

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
    throw new Error('No se pudieron leer las líneas del presupuesto (JSON inválido).')
  }
  if (!Array.isArray(crudo)) throw new Error('Las líneas del presupuesto llegaron en un formato inesperado.')

  const vistos = new Set<number>()
  return crudo.map((raw, i): ItemInput => {
    const it = raw as Partial<ItemInput>
    const productId = Number(it.productId)
    const quantity = Number(it.quantity)
    const salePrice = Number(it.salePrice)

    if (!Number.isInteger(productId) || productId <= 0) throw new Error(`Línea ${i + 1}: producto inválido.`)
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Línea ${i + 1}: la cantidad tiene que ser un entero ≥ 1.`)
    if (!Number.isFinite(salePrice) || salePrice < 0) throw new Error(`Línea ${i + 1}: el precio de venta no es un número válido.`)
    if (vistos.has(productId)) throw new Error(`El producto ${productId} aparece dos veces en el presupuesto.`)
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
 * Tira en vez de devolver un error porque estas acciones son `action` de un form y no
 * devuelven nada. Es el último cerrojo, no la vía normal de enterarse: lo normal es verlas
 * tachadas en el armador. Que falle ruidosamente es preferible a guardar la promesa.
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
  throw new Error(
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

export async function createPresupuesto(formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const tipo = (formData.get('tipo') as string) === 'propio' ? 'propio' : 'cliente'
  const items = parseItems(formData)

  if (items.length === 0) return
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) return
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) return
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
  // Si el lote se armó desde el planificador de embarques, se vuelve ahí: lo que sigue es
  // ver cuánto suma al m³ acumulado, no la ficha del documento suelto.
  if ((formData.get('volver') as string) === 'plan') {
    revalidatePath('/envios/plan')
    redirect('/envios/plan')
  }
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
export async function updatePresupuesto(id: number, formData: FormData) {
  const notas = (formData.get('notas') as string)?.trim() || null
  const existing = await db.pedido.findUnique({
    where: { id },
    select: { tipo: true, status: true, items: { select: { productId: true } } },
  })
  if (!existing) return

  // El mismo candado que la página (edit/page.tsx). Estaba SOLO en la página, así que una
  // pestaña vieja o un POST directo editaba un pedido de cliente ya confirmado. El resto
  // de las acciones del repo ya revalidan su guard del lado del server (ver
  // esBorradorMaritimo en envios/linea-actions); esta se había quedado afuera.
  const editable = existing.status === 'presupuesto' || existing.tipo === 'propio'
  if (!editable) {
    throw new Error('Este pedido ya está confirmado y no se puede editar.')
  }

  const items = parseItems(formData)
  if (items.length === 0) return
  await bloquearDescontinuadas(items)

  let clientName: string
  let clienteId: number | null = null
  if (existing.tipo === 'propio') {
    clientName = (formData.get('clientName') as string)?.trim()
    if (!clientName) return
  } else {
    const cliente = await resolveCliente(formData)
    if (!cliente) return
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
  redirect(`/presupuestos/${id}`)
}

// Aprueba un presupuesto (status -> 'pedido') registrando el adelanto: monto,
// método de pago y fecha. Reutilizable para editar el adelanto de un pedido ya
// confirmado (el status ya es 'pedido' y solo se actualizan los campos del adelanto).
export async function aprobarPedido(id: number, formData: FormData) {
  const rawDeposit = (formData.get('depositUsd') as string)?.trim()
  const depositUsd = rawDeposit ? parseFloat(rawDeposit) : null
  const paymentMethod = (formData.get('paymentMethod') as string)?.trim() || null
  const rawDate = (formData.get('depositAt') as string)?.trim()
  // El input date da 'YYYY-MM-DD'; se ancla a mediodía para evitar corrimientos de zona horaria.
  const depositAt = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()

  await db.pedido.update({
    where: { id },
    data: {
      status: 'pedido',
      depositUsd: depositUsd != null && !Number.isNaN(depositUsd) ? depositUsd : null,
      paymentMethod,
      depositAt,
    },
  })
  revalidatePath('/presupuestos')
  revalidatePath(`/presupuestos/${id}`)
  // El adelanto y el pase a 'pedido' mueven los totales del cliente.
  revalidateClientes()
}

export async function deletePresupuesto(id: number) {
  await db.pedido.delete({ where: { id } })
  revalidatePath('/presupuestos')
  revalidateClientes()
  redirect('/presupuestos')
}
