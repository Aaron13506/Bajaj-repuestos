'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { inboundDe } from '@/lib/inbound'

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

export async function createSupplier(formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  const origen = parseOrigen(formData)
  await db.supplier.create({
    data: {
      name,
      origen,
      inbound: parseInbound(formData, origen),
      fobUsd: parseFob(formData),
    },
  })
  revalidatePath('/suppliers')
  revalidatePath('/', 'layout')
}

// Guarda toda la fila junta (un solo form por proveedor). Cambiar el origen o el inbound
// NO reescribe los ítems ya comprados: cada PedidoItem guarda su propio snapshot, así que
// lo que ya viajó conserva la ruta y el costeo con los que se compró.
export async function renameSupplier(id: number, formData: FormData) {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return
  const origen = parseOrigen(formData)
  await db.supplier.update({
    where: { id },
    data: {
      name,
      origen,
      inbound: parseInbound(formData, origen),
      fobUsd: parseFob(formData),
    },
  })
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
}

export async function deleteSupplier(id: number) {
  await db.supplier.delete({ where: { id } })
  revalidatePath('/suppliers')
  revalidatePath('/envios')
  revalidatePath('/', 'layout')
}
