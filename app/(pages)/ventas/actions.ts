'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { findOrCreateCliente, revalidateClientes } from '@/lib/clientes'
import { ErrorDeNegocio, conErrorDeNegocio, type ActionResult } from '@/lib/action-result'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap } from '@/lib/config'
import { cobraEnBolivares } from '@/lib/pagos'
import { leerCobroBs } from '@/lib/cuentas'
import { bloquearPedido, cobrarPedido } from '@/lib/movimientos'
import { costoDeLinea, motivoNoVendible, type LineaVenta } from '@/lib/venta-stock'
import { toModelIds, type MotoModelId } from '@/lib/modelo'
import { whereModel } from '@/lib/catalog'

// Una pieza del depósito tal como la ve el formulario de venta.
export interface PiezaEnStock {
  id: number
  nameEs: string
  bajajCode: string | null
  stock: number
  price: number
  imageUrl: string | null
  models: MotoModelId[]
  // Lo que cuesta reponerla hoy (el mismo costo con el que se valúa el inventario). Null = la
  // pieza no tiene costo cargado y hay que escribirlo en la venta.
  costoUnitUsd: number | null
}

const SELECT_EN_STOCK = {
  id: true, nameEs: true, bajajCode: true, stock: true, price: true, imageUrl: true,
  compatibleModels: true, landedCostUsd: true,
} as const

function aPiezaEnStock(p: {
  id: number; nameEs: string; bajajCode: string | null; stock: number; price: { toString(): string }
  imageUrl: string | null; compatibleModels: string | null; landedCostUsd: { toString(): string } | null
}): PiezaEnStock {
  return {
    id: p.id,
    nameEs: p.nameEs,
    bajajCode: p.bajajCode,
    stock: p.stock,
    price: parseFloat(p.price.toString()),
    imageUrl: p.imageUrl,
    models: toModelIds(p.compatibleModels),
    costoUnitUsd: p.landedCostUsd != null ? parseFloat(p.landedCostUsd.toString()) : null,
  }
}

// Solo lo que se puede vender: piezas con stock. Una venta directa saca del depósito, así que
// una pieza en cero no tiene nada que hacer en el buscador (para eso está el presupuesto).
// `modelo` es el mismo filtro de moto que el armador de presupuestos.
export async function buscarEnStock(term: string, modelo?: string) {
  const q = term.trim()
  if (q.length < 2) return []
  const rows = await db.product.findMany({
    where: {
      stock: { gt: 0 },
      ...whereModel(modelo),
      OR: [
        { nameEs: { contains: q, mode: 'insensitive' } },
        { bajajCode: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: SELECT_EN_STOCK,
    take: 12,
    orderBy: { nameEs: 'asc' },
  })
  return rows.map(aPiezaEnStock)
}

// Las piezas de UN ensamble que están en el depósito, agrupadas como en el despiece. Las que
// no tienen stock no se listan: no se pueden vender. Se cargan al abrir el ensamble, igual que
// en el armador de presupuestos.
export async function getComponentesEnStock(ensambleId: number) {
  const comps = await db.ensambleComponente.findMany({
    where: { ensambleId, product: { stock: { gt: 0 } } },
    select: { id: true, groupName: true, sortOrder: true, product: { select: SELECT_EN_STOCK } },
    orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  })
  return comps.map(c => ({ id: c.id, groupName: c.groupName, product: aPiezaEnStock(c.product) }))
}

function leerLineas(formData: FormData): LineaVenta[] {
  let crudo: unknown
  try {
    crudo = JSON.parse((formData.get('items') as string) ?? '')
  } catch {
    throw new ErrorDeNegocio('No se pudieron leer las piezas de la venta. Recargá la página.')
  }
  if (!Array.isArray(crudo)) throw new ErrorDeNegocio('Las piezas de la venta llegaron en un formato inesperado.')
  return crudo.map(raw => {
    const l = raw as Partial<Record<keyof LineaVenta, unknown>>
    return {
      productId: Number(l.productId),
      quantity: Number(l.quantity),
      salePrice: Number(l.salePrice),
      costoUnitUsd: Number(l.costoUnitUsd),
    }
  })
}

async function resolverCliente(formData: FormData) {
  const raw = ((formData.get('clienteId') as string) ?? '').trim()
  if (raw === '__new__') {
    const nombre = (formData.get('nuevoClienteNombre') as string)?.trim()
    if (!nombre) return null
    const telefono = (formData.get('nuevoClienteTelefono') as string)?.trim() || null
    return (await findOrCreateCliente(nombre, telefono)).cliente
  }
  const id = parseInt(raw)
  return Number.isNaN(id) ? null : db.cliente.findUnique({ where: { id } })
}

// Un cobro del formulario (`sufijo` '' o '2'). Vacío = todavía no pagó; un número ilegible o
// negativo no es ninguna de las dos cosas. En Bs se escriben los bolívares y la tasa, y los
// dólares salen de dividir.
function leerCobro(formData: FormData, sufijo: string) {
  const metodoPago = (formData.get(`metodoPago${sufijo}`) as string)?.trim() || null
  const bs = leerCobroBs(formData, metodoPago, true, sufijo)
  if (!bs.ok) throw new ErrorDeNegocio(bs.error)
  if (bs.cobro) return { metodoPago, monto: bs.cobro.montoUsd, bs: bs.cobro }
  const raw = (formData.get(`monto${sufijo}`) as string)?.trim()
  if (!raw || cobraEnBolivares(metodoPago)) return null
  const monto = parseFloat(raw)
  if (!Number.isFinite(monto) || monto <= 0) throw new ErrorDeNegocio('El monto cobrado tiene que ser mayor que 0 (o dejalo vacío si todavía no pagó).')
  return { metodoPago, monto, bs: null }
}

// Una venta del depósito: el pedido nace confirmado y entregado, el stock baja en la misma
// transacción y, si el cliente pagó algo, el cobro entra al libro por la misma puerta que
// cualquier otro (cobrarPedido: conversión BCV, Bs y tasa). Sin monto, queda por cobrar.
export async function registrarVenta(formData: FormData): Promise<ActionResult> {
  return conErrorDeNegocio(() => crearVenta(formData))
}

async function crearVenta(formData: FormData) {
  const lineas = leerLineas(formData)
  const cliente = await resolverCliente(formData)
  if (!cliente) throw new ErrorDeNegocio('Elegí un cliente, o escribí el nombre del nuevo.')

  const notas = (formData.get('notas') as string)?.trim() || null
  const rawFecha = (formData.get('fecha') as string)?.trim()
  const fecha = rawFecha ? new Date(`${rawFecha}T12:00:00`) : new Date()
  // Hasta dos cobros (parte en Bs y parte en efectivo): cada uno entra al libro por separado.
  const cobros = ['', '2'].map(s => leerCobro(formData, s)).filter(c => c != null)

  const cfg = toConfigMap(await db.config.findMany())
  // Como un pedido de cliente: el escalón de hoy queda congelado y el cliente ve el total a BCV.
  const escalon = escalonBcvVigente(cfg)
  const ahora = new Date()

  const pedido = await db.$transaction(async tx => {
    const piezas = await tx.product.findMany({
      where: { id: { in: lineas.map(l => l.productId).filter(Number.isInteger) } },
      select: { id: true, stock: true, nameEs: true, bajajCode: true },
    })
    const motivo = motivoNoVendible(lineas, piezas)
    if (motivo) throw new ErrorDeNegocio(motivo)

    // El stock baja con una escritura condicionada, no leyendo y restando: si dos ventas
    // compiten por la última unidad, la segunda no encuentra stock y la transacción entera se
    // deshace — el pedido, el cobro y lo que la primera línea ya había descontado.
    for (const l of lineas) {
      const n = await tx.$executeRaw`
        UPDATE "Product" SET "stock" = "stock" - ${l.quantity}, "updatedAt" = NOW()
        WHERE "id" = ${l.productId} AND "stock" >= ${l.quantity}`
      if (n === 0) {
        const p = piezas.find(x => x.id === l.productId)!
        throw new ErrorDeNegocio(`${p.bajajCode ?? p.nameEs}: ya no alcanza el stock (otra venta se lo llevó). Recargá la página.`)
      }
    }

    const creado = await tx.pedido.create({
      data: {
        clientName: cliente.nombre,
        clienteId: cliente.id,
        notas,
        tipo: 'venta',
        status: 'pedido',
        brechaEscalonPct: escalon,
        ...(cobros.length > 0 ? { paymentMethod: cobros[0].metodoPago, depositAt: fecha } : {}),
        items: {
          create: lineas.map(l => ({
            productId: l.productId,
            quantity: l.quantity,
            salePrice: l.salePrice,
            shippingStatus: 'entregado',
            shippingStatusAt: ahora,
            compradoAt: ahora,
            costRealUsd: costoDeLinea(l.costoUnitUsd, l.quantity),
          })),
        },
      },
    })

    for (const c of cobros) {
      const r = await cobrarPedido(tx, {
        pedidoId: creado.id, monto: c.monto, categoria: 'pago_cliente', fecha, metodoPago: c.metodoPago,
        descripcion: 'Venta directa', tasaBs: c.bs?.tasaBs, montoBs: c.bs?.montoBs,
      })
      if (!r.ok) throw new ErrorDeNegocio(r.error)
    }
    return creado
  }, { maxWait: 10_000, timeout: 20_000 })

  revalidarVentas()
  redirect(`/presupuestos/${pedido.id}`)
}

// Deshace una venta que no debió existir (se cargó mal, el cliente no se llevó nada): devuelve
// las piezas al depósito, saca sus cobros del libro y borra el pedido. NO es una devolución:
// plata que el cliente ya se llevó con la mercancía y vuelve es un egreso aparte, igual que
// corregir un adelanto no es reembolsarlo.
export async function anularVenta(id: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => deshacerVenta(id))
  if (!r.ok) return r
  revalidarVentas()
  redirect('/presupuestos')
}

async function deshacerVenta(id: number) {
  await db.$transaction(async tx => {
    // El cerrojo del pedido primero, como en toda acción que toca sus movimientos.
    if (!(await bloquearPedido(tx, id))) return // ya la había anulado otra request

    const p = await tx.pedido.findUnique({
      where: { id },
      select: { tipo: true, items: { select: { productId: true, quantity: true } } },
    })
    if (!p) return
    if (p.tipo !== 'venta') throw new ErrorDeNegocio('Solo una venta directa se puede anular así.')

    const otros = await tx.movimiento.count({ where: { pedidoId: id, tipo: { not: 'ingreso' } } })
    if (otros > 0) throw new ErrorDeNegocio('Tiene egresos en el libro: sacalos primero.')

    for (const it of p.items) {
      if (it.productId != null) {
        await tx.product.update({ where: { id: it.productId }, data: { stock: { increment: it.quantity } } })
      }
    }
    await tx.movimiento.deleteMany({ where: { pedidoId: id } })
    await tx.pedido.delete({ where: { id } })
  })
}

function revalidarVentas() {
  revalidatePath('/presupuestos')
  revalidatePath('/inventario')
  revalidatePath('/products')
  revalidatePath('/contabilidad')
  revalidatePath('/')
  revalidateClientes()
}
