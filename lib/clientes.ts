import { Prisma } from '@prisma/client'
import { isUniqueViolation } from '@/lib/prisma-errors'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { ErrorDeNegocio } from '@/lib/action-result'
import { telefonoIntl } from '@/lib/utils'

// Solo un pedido CONFIRMADO cuenta como venta. Un presupuesto sin aprobar todavía
// puede caerse, así que no debe inflar el total vendido ni el saldo del cliente.
export const VENTA_STATUS = 'pedido'

export { isUniqueViolation }

// Busca por nombre ignorando mayúsculas. El @unique de Postgres SÍ distingue
// mayúsculas, así que pueden convivir "Andry" y "andry" (heredados de datos viejos):
// el orderBy hace que siempre gane el más antiguo y el resultado sea determinístico.
export function findClienteByNombre(nombre: string) {
  return db.cliente.findFirst({
    where: { nombre: { equals: nombre, mode: 'insensitive' } },
    orderBy: { id: 'asc' },
  })
}

// Devuelve el cliente y si hubo que crearlo (el llamador avisa cuando ya existía en
// vez de crear un duplicado silencioso).
// Ningún cliente sin teléfono completo: es por donde se le cobra y se le avisa (WhatsApp).
// Null = está bien. Lo usan todos los caminos que crean, editan o eligen un cliente.
export function motivoSinTelefono(nombre: string, telefono: string | null | undefined): string | null {
  if (!telefono?.trim()) return `Falta el teléfono de ${nombre}: ningún cliente puede quedar sin teléfono.`
  if (!telefonoIntl(telefono)) return `El teléfono de ${nombre} no está completo: escribilo con el código, ej. 0414-1234567.`
  return null
}

// Un cliente ya guardado (elegido de la lista) sin teléfono no se usa hasta cargárselo en su ficha.
export function exigirTelefono<C extends { nombre: string; telefono: string | null }>(cliente: C): C {
  const motivo = motivoSinTelefono(cliente.nombre, cliente.telefono)
  if (motivo) throw new ErrorDeNegocio(`${motivo} Cargalo en su ficha de Clientes.`)
  return cliente
}

// El teléfono escrito reemplaza al guardado; vacío solo vale si el que ya existe tiene uno.
// Lanza ErrorDeNegocio (el llamador lo envuelve con conErrorDeNegocio) ANTES de crear nada.
export async function findOrCreateCliente(
  nombre: string,
  telefono?: string | null,
): Promise<{ cliente: { id: number; nombre: string }; created: boolean }> {
  const tel = telefono?.trim() || null
  const existing = await findClienteByNombre(nombre)
  const motivo = motivoSinTelefono(existing?.nombre ?? nombre, tel ?? existing?.telefono)
  if (motivo) throw new ErrorDeNegocio(motivo)
  if (existing) {
    if (tel && tel !== existing.telefono) await db.cliente.update({ where: { id: existing.id }, data: { telefono: tel } })
    return { cliente: existing, created: false }
  }

  try {
    const cliente = await db.cliente.create({ data: { nombre, telefono: tel } })
    return { cliente, created: true }
  } catch (e) {
    // Otro submit lo creó entre el find y el create: nos quedamos con el que ganó.
    if (isUniqueViolation(e)) {
      const raced = await findClienteByNombre(nombre)
      if (raced) return { cliente: raced, created: false }
    }
    throw e
  }
}

// Los totales de un cliente dependen de sus pedidos, así que cualquier acción que
// toque un Pedido (aprobar, editar, borrar) tiene que invalidar la lista y las fichas.
// Solo llamable desde server actions / route handlers.
export function revalidateClientes() {
  revalidatePath('/clientes')
  revalidatePath('/clientes/[id]', 'page')
}

interface PedidoTotales {
  status: string
  depositUsd: Prisma.Decimal | null
  items: { salePrice: Prisma.Decimal; quantity: number }[]
}

export interface ClienteTotales {
  vendido: number
  adelantado: number
  saldo: number
  confirmados: number
}

const num = (d: Prisma.Decimal | null | undefined) => (d != null ? parseFloat(d.toString()) : 0)

export function pedidoTotal(items: { salePrice: Prisma.Decimal; quantity: number }[]): number {
  return items.reduce((sum, i) => sum + num(i.salePrice) * i.quantity, 0)
}

// Filtra por status acá adentro (no en la query) para que la regla de "qué cuenta como
// venta" viva en un solo lugar, sirva igual con la lista o con la ficha, y no se pueda
// olvidar en un call site nuevo.
export function clienteTotales(pedidos: PedidoTotales[]): ClienteTotales {
  const confirmados = pedidos.filter(p => p.status === VENTA_STATUS)
  const vendido = confirmados.reduce((sum, p) => sum + pedidoTotal(p.items), 0)
  const adelantado = confirmados.reduce((sum, p) => sum + num(p.depositUsd), 0)
  return { vendido, adelantado, saldo: vendido - adelantado, confirmados: confirmados.length }
}

// ─── Cobranza de una caja ────────────────────────────────────────────────────
// Cuánto de lo que viaja en un envío ya está cobrado y cuánto falta. El adelanto
// vive en el PEDIDO, no en la línea, así que acá NO se prorratea por lo que entró
// en la caja: el cliente adelantó contra su pedido entero y esa es la deuda real.
// Cuando el pedido está partido entre cajas se marca `parcial` y el total sigue
// siendo el del pedido completo — prorratear inventaría una asignación que nadie
// pactó y haría que la suma de dos cajas no dé la deuda del cliente.
interface PedidoCobranzaInput {
  id: number
  clientName: string
  tipo: string
  status: string
  depositUsd: Prisma.Decimal | null
  items: { salePrice: Prisma.Decimal; quantity: number; envioId: number | null }[]
}

export interface CobranzaPedido {
  pedidoId: number
  clientName: string
  total: number
  recibido: number
  falta: number
  itemsEnCaja: number
  itemsTotal: number
  parcial: boolean
  // Confirmado pero sin adelanto cargado: no es lo mismo que un adelanto de $0,
  // es un dato que falta y por eso se muestra distinto.
  sinAdelanto: boolean
}

export interface CobranzaEnvio {
  pedidos: CobranzaPedido[]
  vendido: number
  recibido: number
  falta: number
  // Presupuestos sin aprobar metidos en la caja: todavía no son una venta, así que
  // no suman ni a lo cobrado ni a lo que falta cobrar — pero sí se están comprando.
  sinAprobar: { pedidos: number; total: number }
  // Stock propio: no hay cliente ni deuda, solo plata que sale.
  propios: { pedidos: number; total: number }
}

export function cobranzaEnvio(pedidos: PedidoCobranzaInput[], envioId: number): CobranzaEnvio {
  const rows: CobranzaPedido[] = []
  const sinAprobar = { pedidos: 0, total: 0 }
  const propios = { pedidos: 0, total: 0 }

  for (const p of pedidos) {
    const total = pedidoTotal(p.items)
    if (p.tipo === 'propio') {
      propios.pedidos++
      propios.total += total
      continue
    }
    if (p.status !== VENTA_STATUS) {
      sinAprobar.pedidos++
      sinAprobar.total += total
      continue
    }
    const recibido = num(p.depositUsd)
    const itemsEnCaja = p.items.filter(i => i.envioId === envioId).length
    rows.push({
      pedidoId: p.id,
      clientName: p.clientName,
      total,
      recibido,
      falta: total - recibido,
      itemsEnCaja,
      itemsTotal: p.items.length,
      parcial: itemsEnCaja < p.items.length,
      sinAdelanto: p.depositUsd == null,
    })
  }

  rows.sort((a, b) => b.falta - a.falta)
  return {
    pedidos: rows,
    vendido: rows.reduce((s, r) => s + r.total, 0),
    recibido: rows.reduce((s, r) => s + r.recibido, 0),
    falta: rows.reduce((s, r) => s + r.falta, 0),
    sinAprobar,
    propios,
  }
}
