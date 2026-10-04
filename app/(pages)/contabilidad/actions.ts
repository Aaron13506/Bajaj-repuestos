'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import {
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  tipoDeCategoria,
  registrarCompra as registrarCompraLib,
  registrarIngresoPedido,
  bloquearPedido,
  ajustarDeposito,
} from '@/lib/movimientos'
import { revalidateClientes } from '@/lib/clientes'
import { ok, fallo, type ActionResult } from '@/lib/action-result'
import { isForeignKeyViolation } from '@/lib/prisma-errors'

const CATEGORIAS_VALIDAS = new Set<string>([...CATEGORIAS_INGRESO, ...CATEGORIAS_EGRESO])

function optionalInt(formData: FormData, name: string): number | null {
  const raw = (formData.get(name) as string)?.trim()
  if (!raw) return null
  const v = parseInt(raw)
  return Number.isFinite(v) ? v : null
}

// Asiento suelto del libro: no todo movimiento tiene un pedido/envío/proveedor detrás
// (un gasto operativo no va atado a nada). Los tres links son independientes.
//
// Un INGRESO ligado a un pedido es un cobro de ese pedido, y por eso pasa por
// registrarIngresoPedido: además del movimiento suma a Pedido.depositUsd, la caché que leen
// cobranza y clientes. Antes este camino solo creaba el movimiento, y el pedido seguía
// mostrando lo cobrado de antes — hasta que se borraba el movimiento, que SÍ restaba del
// depósito y lo dejaba por debajo de lo real.
export async function crearMovimiento(formData: FormData): Promise<ActionResult> {
  const categoria = (formData.get('categoria') as string)?.trim() ?? ''
  if (!CATEGORIAS_VALIDAS.has(categoria)) return fallo('Elegí una categoría.')

  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')

  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const pedidoId = optionalInt(formData, 'pedidoId')
  const envioId = optionalInt(formData, 'envioId')
  const supplierId = optionalInt(formData, 'supplierId')
  const tipo = tipoDeCategoria(categoria)

  try {
    if (tipo === 'ingreso' && pedidoId != null) {
      await db.$transaction(tx =>
        registrarIngresoPedido(tx, { pedidoId, monto, categoria, fecha, metodoPago, descripcion, envioId, supplierId }),
      )
    } else {
      await db.movimiento.create({
        data: { fecha, tipo, categoria, monto, metodoPago, descripcion, pedidoId, envioId, supplierId },
      })
    }
  } catch (e) {
    // El pedido, el envío o el proveedor se borró desde otra pestaña después de armar la lista.
    if (isForeignKeyViolation(e)) return fallo('El pedido, envío o proveedor elegido ya no existe. Recargá la página.')
    throw e
  }

  revalidatePath('/contabilidad')
  if (pedidoId) {
    revalidatePath('/presupuestos')
    revalidatePath(`/presupuestos/${pedidoId}`)
    revalidateClientes()
  }
  if (envioId) revalidatePath(`/envios/${envioId}`)
  return ok()
}

// Borrar un movimiento ligado a un pedido tiene que revertir la caché de depositUsd que
// mantiene el resto de las acciones de cobro (ver registrarIngresoPedido) — si no, el pedido
// quedaría mostrando plata recibida que el libro ya no dice que entró.
//
// El borrado es `deleteMany` y se mira cuántos borró: si otra request (dos pestañas, un
// reintento) ya lo había borrado, `count` es 0 y NO se vuelve a restar del depósito. Con un
// `delete` simple la segunda tiraba P2025 y terminaba en la página de error.
export async function eliminarMovimiento(id: number) {
  await db.$transaction(async tx => {
    const mov = await tx.movimiento.findUnique({
      where: { id },
      select: { pedidoId: true, monto: true, tipo: true },
    })
    if (!mov) return

    const esCobro = mov.pedidoId != null && mov.tipo === 'ingreso'
    // Cerrojo del pedido ANTES de tocar sus movimientos: mismo orden que el resto de las
    // acciones de cobro, para que dos de ellas sobre el mismo pedido no se interbloqueen.
    if (esCobro) await bloquearPedido(tx, mov.pedidoId!)

    const borrados = await tx.movimiento.deleteMany({ where: { id } })
    if (borrados.count === 0) return

    if (esCobro) await ajustarDeposito(tx, mov.pedidoId!, -parseFloat(mov.monto.toString()))
  })

  revalidatePath('/contabilidad')
  revalidatePath('/presupuestos')
  revalidateClientes()
}

// Apertura de caja: ancla el saldo mostrado a `saldoInicial + flujo real desde esta
// fecha`, sin tocar el libro (ver aperturaCaja en lib/movimientos.ts). Vive en Config, no
// en una tabla propia — dos keys, igual que cualquier otro valor declarado a mano.
export async function guardarAperturaCaja(formData: FormData): Promise<ActionResult> {
  const rawFecha = (formData.get('desde') as string)?.trim()
  if (!rawFecha || isNaN(new Date(`${rawFecha}T00:00:00`).getTime())) return fallo('Elegí la fecha de apertura.')

  const rawMonto = (formData.get('saldoInicial') as string)?.trim()
  if (!rawMonto || !Number.isFinite(parseFloat(rawMonto))) return fallo('Escribí el saldo de apertura.')

  await db.$transaction([
    db.config.upsert({
      where: { key: 'caja_apertura_desde' },
      create: { key: 'caja_apertura_desde', value: rawFecha, description: 'Fecha desde la que se ancla el saldo de caja (ver /contabilidad)' },
      update: { value: rawFecha },
    }),
    db.config.upsert({
      where: { key: 'caja_apertura_usd' },
      create: { key: 'caja_apertura_usd', value: rawMonto, description: 'Saldo declarado a la fecha de apertura, en USD' },
      update: { value: rawMonto },
    }),
  ])
  revalidatePath('/contabilidad')
  return ok()
}

// Wrapper 'use server': la cuenta y el prorrateo viven en lib/movimientos.ts (puro,
// reusable), esto solo agrega la revalidación de las páginas que quedan desactualizadas.
// Devuelve el resultado (y no `void`) porque la compra puede rechazarse —piezas que ya
// tenían costo cargado— y el formulario tiene que poder decirlo en vez de limpiarse como si
// hubiera guardado.
export async function registrarCompra(formData: FormData): Promise<ActionResult> {
  const r = await registrarCompraLib(formData)
  if (!r.ok) return fallo(r.error)

  revalidatePath('/contabilidad')
  revalidatePath('/contabilidad/comprar')
  for (const id of r.pedidoIds) revalidatePath(`/presupuestos/${id}`)
  // La lista de envíos se refresca siempre: una compra que mezcla cajas no tiene un envío
  // dueño, pero igual movió el costo real de cada una.
  revalidatePath('/envios')
  if (r.envioId != null) revalidatePath(`/envios/${r.envioId}`)
  return ok()
}
