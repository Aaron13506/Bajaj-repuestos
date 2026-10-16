'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import {
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  tipoDeCategoria,
  registrarCompra as registrarCompraLib,
  cobrarPedido,
  bloquearPedido,
  ajustarDeposito,
  registrarConversion,
} from '@/lib/movimientos'
import { revalidateClientes } from '@/lib/clientes'
import { ok, fallo, type ActionResult } from '@/lib/action-result'
import { isForeignKeyViolation } from '@/lib/prisma-errors'
import { cuentaDeMetodo, datosBs, leerCobroBs } from '@/lib/cuentas'
import { toConfigMap } from '@/lib/config'

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
// Un INGRESO ligado a un pedido es un cobro de ese pedido, y por eso pasa por cobrarPedido:
// convierte lo escrito a dólares reales (BCV) y, además del movimiento, suma a
// Pedido.depositUsd, la caché que leen cobranza y clientes. Antes este camino solo creaba el
// movimiento, y el pedido seguía mostrando lo cobrado de antes — hasta que se borraba el
// movimiento, que SÍ restaba del depósito y lo dejaba por debajo de lo real.
export async function crearMovimiento(formData: FormData): Promise<ActionResult> {
  const categoria = (formData.get('categoria') as string)?.trim() ?? ''
  if (!CATEGORIAS_VALIDAS.has(categoria)) return fallo('Elegí una categoría.')

  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const tipo = tipoDeCategoria(categoria)
  // Un ingreso en Bs se escribe en bolívares y tasa; los dólares salen de dividir.
  const bs = leerCobroBs(formData, tipo === 'ingreso' ? metodoPago : null)
  if (!bs.ok) return fallo(bs.error)
  const monto = bs.cobro ? bs.cobro.montoUsd : parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return fallo('El monto tiene que ser mayor que 0.')

  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const pedidoId = optionalInt(formData, 'pedidoId')
  const envioId = optionalInt(formData, 'envioId')
  const supplierId = optionalInt(formData, 'supplierId')

  try {
    if (tipo === 'ingreso' && pedidoId != null) {
      // Misma conversión que el formulario de pago de la ficha del pedido: en un pedido a dólar
      // BCV, lo escrito en Bs son dólares BCV y lo que se guarda es su valor real.
      const r = await db.$transaction(
        tx => cobrarPedido(tx, { pedidoId, monto, categoria, fecha, metodoPago, descripcion, envioId, supplierId, tasaBs: bs.cobro?.tasaBs, montoBs: bs.cobro?.montoBs }),
        { maxWait: 10_000, timeout: 20_000 },
      )
      if (!r.ok) return r
    } else {
      const datos = datosBs(metodoPago, monto, bs.cobro?.tasaBs ?? null, bs.cobro?.montoBs)
      await db.movimiento.create({
        data: {
          fecha, tipo, categoria, monto, metodoPago, descripcion, pedidoId, envioId, supplierId,
          cuenta: cuentaDeMetodo(metodoPago), montoBs: datos?.montoBs ?? null, tasaBs: datos?.tasaBs ?? null,
        },
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
  let envioId = null as number | null
  await db.$transaction(async tx => {
    const mov = await tx.movimiento.findUnique({
      where: { id },
      select: { pedidoId: true, monto: true, tipo: true, envioId: true, grupo: true, categoria: true },
    })
    if (!mov) return
    envioId = mov.envioId

    // Las dos patas de una conversión se van juntas: una sola descuadraría la caja.
    if (mov.grupo != null) {
      await tx.movimiento.deleteMany({ where: { grupo: mov.grupo } })
      return
    }

    const esCobro = mov.pedidoId != null && mov.tipo === 'ingreso'
    // Una devolución a un cliente baja el depósito al anotarse: borrarla lo devuelve a lo que era.
    const esDevolucion = mov.pedidoId != null && mov.categoria === 'devolucion_cliente'
    // Cerrojo del pedido ANTES de tocar sus movimientos: mismo orden que el resto de las
    // acciones de cobro, para que dos de ellas sobre el mismo pedido no se interbloqueen.
    if (esCobro || esDevolucion) await bloquearPedido(tx, mov.pedidoId!)

    const borrados = await tx.movimiento.deleteMany({ where: { id } })
    if (borrados.count === 0) return

    if (esCobro) await ajustarDeposito(tx, mov.pedidoId!, -parseFloat(mov.monto.toString()))
    if (esDevolucion) await ajustarDeposito(tx, mov.pedidoId!, parseFloat(mov.monto.toString()))
  })

  revalidatePath('/contabilidad')
  revalidatePath('/presupuestos')
  // Un pago contra una caja (proveedor, flete) se ve en su ficha y en la lista: sin esto, borrarlo
  // desde acá dejaba la caja mostrando "pagado".
  if (envioId != null) {
    revalidatePath('/envios')
    revalidatePath(`/envios/${envioId}`)
  }
  revalidateClientes()
}

// Pasar Bs a USDT: lo que se dio y lo que se recibió. El libro anota las dos patas y el costo
// de convertir sale de la diferencia (ver registrarConversion).
export async function crearConversion(formData: FormData): Promise<ActionResult> {
  const leer = (n: string) => parseFloat(String(formData.get(n) ?? '').trim().replace(',', '.'))
  const rawDate = (formData.get('fecha') as string)?.trim()
  const r = await registrarConversion(
    {
      bs: leer('bs'),
      usdt: leer('usdt'),
      fecha: rawDate ? new Date(`${rawDate}T12:00:00`) : new Date(),
      descripcion: (formData.get('descripcion') as string)?.trim() || null,
    },
    toConfigMap(await db.config.findMany()),
  )
  if (!r.ok) return r
  revalidatePath('/contabilidad')
  return ok()
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
