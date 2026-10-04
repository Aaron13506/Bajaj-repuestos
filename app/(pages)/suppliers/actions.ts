'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { inboundDe } from '@/lib/inbound'
import { motivoProveedorEnUso } from '@/lib/proveedor-en-uso'
import { conErrorDeNegocio, ErrorDeNegocio, fallo, ok, type ActionResult } from '@/lib/action-result'
import { isUniqueViolation } from '@/lib/prisma-errors'

// De dónde sale la mercancía. Hoy es sobre todo informativo: quien decide la ruta y el
// costeo del tramo es `inbound`, no el país — un proveedor indio puede entrar por Shoppre
// o despachar él mismo a USA.
function parseOrigen(formData: FormData): 'india' | 'china' {
  return formData.get('origen') === 'china' ? 'china' : 'india'
}

// Por dónde entra a USA lo que se le compra: 'shoppre' (tabla escalón de ShipGlobal sobre
// el peso del grupo) o 'cotizado' (el proveedor despacha por su cuenta y pasa un total).
// Pasa por inboundDe para que un proveedor chino quede siempre en 'cotizado': ese tramo
// nunca tuvo tabla, y dejarlo elegir Shoppre sería ofrecer una opción que no existe.
function parseInbound(formData: FormData, origen: 'india' | 'china'): 'shoppre' | 'cotizado' {
  return inboundDe(origen, formData.get('inbound') as string)
}

// FOB propio del proveedor, en USD por embarque marítimo. Vacío ⇒ null, y el embarque cae
// al default global de Config (cbm_fob_india_usd). No es un dato del producto ni de la
// naviera: es lo que ESTE proveedor cobra por sacar la carga.
function parseFob(formData: FormData): number | null {
  const raw = (formData.get('fobUsd') as string)?.trim()
  if (!raw) return null
  const n = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export async function createSupplier(formData: FormData): Promise<ActionResult> {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return fallo('Escribí el nombre del proveedor.')
  const origen = parseOrigen(formData)
  try {
    await db.supplier.create({
      data: {
        name,
        origen,
        inbound: parseInbound(formData, origen),
        fobUsd: parseFob(formData),
      },
    })
  } catch (e) {
    // `name` es único: un doble envío o un nombre ya cargado llegaba como un P2002 crudo.
    if (isUniqueViolation(e)) return fallo(`Ya hay un proveedor llamado "${name}".`)
    throw e
  }
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
  return ok()
}

// Guarda toda la fila junta (un solo form por proveedor). Cambiar el origen o el inbound
// NO reescribe los ítems ya comprados: cada PedidoItem guarda su propio snapshot, así que
// lo que ya viajó conserva la ruta y el costeo con los que se compró.
export async function renameSupplier(id: number, formData: FormData): Promise<ActionResult> {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return fallo('Escribí el nombre del proveedor.')
  const origen = parseOrigen(formData)
  try {
    const r = await db.supplier.updateMany({
      where: { id },
      data: {
        name,
        origen,
        inbound: parseInbound(formData, origen),
        fobUsd: parseFob(formData),
      },
    })
    if (r.count === 0) return fallo('Ese proveedor ya no existe. Recargá la página.')
  } catch (e) {
    if (isUniqueViolation(e)) return fallo(`Ya hay un proveedor llamado "${name}".`)
    throw e
  }
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
  return ok()
}

// Solo se borra un proveedor sin historia (ver motivoProveedorEnUso): uno con cajas, líneas o
// pagos cambiaría el costo de todo eso al desaparecer. La pantalla ya no ofrece el botón en
// ese caso; esto es el cerrojo del lado del server, y devuelve el motivo (`DeleteButton` lo
// muestra) en vez de tirarlo: en producción un throw llega sin el texto.
export async function deleteSupplier(id: number): Promise<ActionResult> {
  const r = await conErrorDeNegocio(() => borrarProveedor(id))
  if (!r.ok) return r
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
  return r
}

async function borrarProveedor(id: number) {
  await db.$transaction(async tx => {
    const s = await tx.supplier.findUnique({
      where: { id },
      select: { _count: { select: { envios: true, pedidoItems: true, movimientos: true } } },
    })
    if (!s) return // ya lo había borrado otra request
    const motivo = motivoProveedorEnUso(s._count)
    if (motivo) throw new ErrorDeNegocio(`No se puede borrar el proveedor. ${motivo}`)
    await tx.supplier.delete({ where: { id } })
  })
}
