'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import {
  CATEGORIAS_INGRESO,
  CATEGORIAS_EGRESO,
  tipoDeCategoria,
  registrarCompra as registrarCompraLib,
} from '@/lib/movimientos'
import { revalidateClientes } from '@/lib/clientes'

const CATEGORIAS_VALIDAS = new Set<string>([...CATEGORIAS_INGRESO, ...CATEGORIAS_EGRESO])

function optionalInt(formData: FormData, name: string): number | null {
  const raw = (formData.get(name) as string)?.trim()
  if (!raw) return null
  const v = parseInt(raw)
  return Number.isFinite(v) ? v : null
}

// Asiento suelto del libro: no todo movimiento tiene un pedido/envío/proveedor detrás
// (un gasto operativo no va atado a nada). Los tres links son independientes.
export async function crearMovimiento(formData: FormData) {
  const categoria = (formData.get('categoria') as string)?.trim() ?? ''
  if (!CATEGORIAS_VALIDAS.has(categoria)) return

  const monto = parseFloat((formData.get('monto') as string)?.trim() ?? '')
  if (!Number.isFinite(monto) || monto <= 0) return

  const rawDate = (formData.get('fecha') as string)?.trim()
  const fecha = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date()
  const metodoPago = (formData.get('metodoPago') as string)?.trim() || null
  const descripcion = (formData.get('descripcion') as string)?.trim() || null
  const pedidoId = optionalInt(formData, 'pedidoId')
  const envioId = optionalInt(formData, 'envioId')
  const supplierId = optionalInt(formData, 'supplierId')

  await db.movimiento.create({
    data: {
      fecha,
      tipo: tipoDeCategoria(categoria),
      categoria,
      monto,
      metodoPago,
      descripcion,
      pedidoId,
      envioId,
      supplierId,
    },
  })

  revalidatePath('/contabilidad')
  if (pedidoId) revalidatePath(`/presupuestos/${pedidoId}`)
  if (envioId) revalidatePath(`/envios/${envioId}`)
}

// Borrar un movimiento ligado a un pedido tiene que revertir la caché de depositUsd que
// mantiene aprobarPedido/registrarPagoPedido — si no, el pedido quedaría mostrando plata
// recibida que el libro ya no dice que entró.
export async function eliminarMovimiento(id: number) {
  await db.$transaction(async (tx) => {
    const mov = await tx.movimiento.findUnique({
      where: { id },
      select: { pedidoId: true, monto: true, tipo: true },
    })
    if (!mov) return

    await tx.movimiento.delete({ where: { id } })

    if (mov.pedidoId != null && mov.tipo === 'ingreso') {
      const pedido = await tx.pedido.findUniqueOrThrow({
        where: { id: mov.pedidoId },
        select: { depositUsd: true },
      })
      const anterior = pedido.depositUsd != null ? parseFloat(pedido.depositUsd.toString()) : 0
      const nuevo = anterior - parseFloat(mov.monto.toString())
      await tx.pedido.update({
        where: { id: mov.pedidoId },
        data: { depositUsd: nuevo > 0.01 ? nuevo : null },
      })
    }
  })

  revalidatePath('/contabilidad')
  revalidatePath('/presupuestos')
  revalidateClientes()
}

// Apertura de caja: ancla el saldo mostrado a `saldoInicial + flujo real desde esta
// fecha`, sin tocar el libro (ver aperturaCaja en lib/movimientos.ts). Vive en Config, no
// en una tabla propia — dos keys, igual que cualquier otro valor declarado a mano.
export async function guardarAperturaCaja(formData: FormData) {
  const rawFecha = (formData.get('desde') as string)?.trim()
  if (!rawFecha) return
  if (isNaN(new Date(`${rawFecha}T00:00:00`).getTime())) return

  const rawMonto = (formData.get('saldoInicial') as string)?.trim()
  if (!rawMonto || !Number.isFinite(parseFloat(rawMonto))) return

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
}

// Wrapper 'use server': la cuenta y el prorrateo viven en lib/movimientos.ts (puro,
// reusable), esto solo agrega la revalidación de las páginas que quedan desactualizadas.
export async function registrarCompra(formData: FormData) {
  const { pedidoIds, envioId } = await registrarCompraLib(formData)
  if (pedidoIds.length === 0) return

  revalidatePath('/contabilidad')
  revalidatePath('/contabilidad/comprar')
  for (const id of pedidoIds) revalidatePath(`/presupuestos/${id}`)
  if (envioId != null) {
    revalidatePath('/envios')
    revalidatePath(`/envios/${envioId}`)
  }
}
