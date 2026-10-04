'use server'

import { db } from '@/lib/db'
import { compatibleModelsFrom } from '@/lib/modelo'
import { calcLanded } from '@/lib/calc'
import { reprice } from '@/lib/reprice'
import { margenPorDefecto } from '@/lib/config'
import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getConfig } from '@/lib/config-db'
import { toNum } from '@/lib/parse'
import { fallo, ok, type ActionResult } from '@/lib/action-result'
import { motivoProductoEnUso } from '@/lib/producto-en-uso'

// Costo landed autoritativo: se recalcula en el server desde el costo de origen
// (₹ INR de 99rpm, o USD directo de un proveedor) + peso + dims y la config vigente,
// así no depende del JS del cliente. Devuelve null si falta el costo o el peso
// (precio queda manual).
async function computeLanded(data: {
  priceInr: number | null
  priceUsd?: number | null
  priceIsLanded?: boolean
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}): Promise<number | null> {
  const cfg = await getConfig()
  const b = calcLanded({ ...data, margin: null }, cfg)
  return b ? Math.round(b.landedCostUsd * 100) / 100 : null
}

function parseProductForm(formData: FormData, modelosActuales: string | null = null) {
  const priceInr     = formData.get('priceInr') as string
  const weightGrams  = formData.get('weightGrams') as string
  const dimL         = formData.get('dimL') as string
  const dimA         = formData.get('dimA') as string
  const dimH         = formData.get('dimH') as string
  const landedCostUsd = formData.get('landedCostUsd') as string
  const margin       = formData.get('margin') as string

  return {
    isAssembly:       formData.get('isAssembly') === 'true',
    bajajCode:        (formData.get('bajajCode') as string) || null,
    sourceUrl:        (formData.get('sourceUrl') as string) || null,
    nameEs:           ((formData.get('nameEs') as string | null) ?? '').trim(),
    nameEn:           (formData.get('nameEn') as string) || null,
    description:      (formData.get('description') as string) || null,
    notes:            (formData.get('notes') as string) || null,
    compatibleModels: compatibleModelsFrom(formData.getAll('models'), modelosActuales),
    weightGrams:      weightGrams ? parseInt(weightGrams) : null,
    dimL:             dimL ? parseFloat(dimL) : null,
    dimA:             dimA ? parseFloat(dimA) : null,
    dimH:             dimH ? parseFloat(dimH) : null,
    priceInr:         priceInr ? parseInt(priceInr) : null,
    landedCostUsd:    landedCostUsd ? parseFloat(landedCostUsd) : null,
    margin:           margin ? parseFloat(margin) / 100 : null,
    // `price` es Decimal NOT NULL: con el campo vacio o ilegible, parseFloat daba NaN,
    // Prisma lo rechazaba y el guardado moria con un 500 sin explicacion. 0 es el mismo
    // criterio que ya usaba `stock` en la linea de abajo — se completa despues.
    price:            toNum(formData.get('price')) ?? 0,
    priceLocked:      formData.get('priceLocked') === 'true',
    stock:            parseInt(formData.get('stock') as string) || 0,
  }
}

// Cuánto cambió el stock EN ESTE FORMULARIO: lo tipeado menos lo que el formulario mostraba
// al abrirse (`stockCargado`). El stock se mueve solo (recibir un embarque suma, vender
// resta), así que guardar el número absoluto pisaba cualquier movimiento ocurrido mientras
// el formulario estaba abierto. Aplicar la diferencia respeta lo que pasó entre medio. Sin
// `stockCargado` (una pestaña vieja) o con el campo ilegible no se toca el stock: ante la
// duda, no inventar un número.
function deltaDeStock(formData: FormData): number {
  const nuevo = parseInt(String(formData.get('stock') ?? ''))
  const cargado = parseInt(String(formData.get('stockCargado') ?? ''))
  if (!Number.isFinite(nuevo) || !Number.isFinite(cargado)) return 0
  return nuevo - cargado
}

export async function createProduct(formData: FormData): Promise<ActionResult> {
  const data     = parseProductForm(formData)
  if (!data.nameEs) return fallo('El nombre en español es obligatorio.')
  const parentId = formData.get('parentId') as string
  const groupName = (formData.get('parentGroupName') as string)?.trim() ?? ''

  const landed = await computeLanded(data)
  if (landed != null) data.landedCostUsd = landed

  const product = await db.product.create({ data })

  if (parentId) {
    const pid = parseInt(parentId)
    if (!isNaN(pid)) {
      await db.productComponent.create({
        data: { parentId: pid, childId: product.id, groupName, quantity: 1 },
      })
    }
  }

  revalidatePath('/products')
  revalidatePath('/groups')
  redirect('/products')
}

export async function updateProduct(id: number, formData: FormData): Promise<ActionResult> {
  const actual = await db.product.findUnique({ where: { id }, select: { compatibleModels: true, stock: true } })
  if (!actual) return fallo('Esa pieza ya no existe.')
  // El stock no se pisa con el absoluto del formulario: se aplica la diferencia (deltaDeStock).
  const { stock: _stockAbsoluto, ...data } = parseProductForm(formData, actual.compatibleModels)
  if (!data.nameEs) return fallo('El nombre en español es obligatorio.')
  const delta = deltaDeStock(formData)
  if (actual.stock + delta < 0) {
    return fallo(`El stock actual es ${actual.stock}: no se puede restar ${-delta}. Cambió desde que abriste el formulario.`)
  }
  const landed = await computeLanded(data)
  if (landed != null) data.landedCostUsd = landed
  await db.product.update({
    where: { id },
    data: { ...data, ...(delta !== 0 ? { stock: { increment: delta } } : {}) },
  })
  revalidatePath('/products')
  revalidatePath('/envios')
  revalidatePath('/groups')
  redirect('/products')
}

// Edición rápida (modal inline): actualiza solo los campos editables y revalida SIN
// redirigir, para quedarse en la misma página.
//
// Hay dos formas de abrirla, y escriben cosas distintas:
//
// · Sin proveedor: es la edición de siempre. Costo de origen (₹, Product.priceInr), margen,
//   precio de venta y stock se guardan tal cual, y el landed se recalcula en el server por
//   la cadena aérea.
//
// · Con proveedor (`?proveedor=` en /products es un filtro de comparación): el precio que se
//   edita es el de ESE proveedor (SupplierPrice, en USD) y nada más del lado del dinero. El
//   precio de venta, el margen y el landed de la pieza salen SIEMPRE del carril aéreo con el
//   precio base de 99rpm — el costo de un proveedor decide dónde abastecerse, no a cuánto se
//   vende. Antes este camino guardaba en `Product.landedCostUsd` un landed del proveedor y en
//   `Product.price` el precio que el modal derivaba de un landed marítimo: lo que se veía en
//   pantalla no era lo que el server calculaba, y lo guardado contradecía al resto del sistema.
//   Lo físico (peso, medidas) sí se guarda, y si cambió se re-costea la pieza con `reprice`,
//   igual que al cargar medidas.
export async function quickUpdateProduct(
  id: number,
  activeSupplierId: number | null,
  formData: FormData,
): Promise<ActionResult> {
  const str = (k: string) => (formData.get(k) as string)?.trim() ?? ''
  const intOrNull   = (k: string) => { const v = str(k); return v ? parseInt(v) : null }
  const floatOrNull = (k: string) => { const v = str(k); return v ? parseFloat(v) : null }

  if (!str('nameEs')) return fallo('El nombre en español es obligatorio.')

  const actual = await db.product.findUnique({
    where: { id },
    select: {
      compatibleModels: true, priceInr: true, margin: true, price: true, priceLocked: true,
      weightGrams: true, dimL: true, dimA: true, dimH: true, stock: true,
    },
  })
  if (!actual) return fallo('Esa pieza ya no existe. Recargá la página.')

  // El stock no se pisa con el absoluto del modal: se aplica la diferencia (ver deltaDeStock).
  const deltaStock = deltaDeStock(formData)
  if (actual.stock + deltaStock < 0) {
    return fallo(`El stock actual es ${actual.stock}: no se puede restar ${-deltaStock}. Cambió desde que abriste la edición.`)
  }
  const ajusteStock = deltaStock !== 0 ? { stock: { increment: deltaStock } } : {}

  const campos = {
    nameEs:           str('nameEs'),
    nameEn:           str('nameEn') || null,
    bajajCode:        str('bajajCode') || null,
    compatibleModels: compatibleModelsFrom(formData.getAll('models'), actual.compatibleModels),
    weightGrams:      intOrNull('weightGrams'),
    dimL:             floatOrNull('dimL'),
    dimA:             floatOrNull('dimA'),
    dimH:             floatOrNull('dimH'),
  }

  if (activeSupplierId) {
    const priceUsd = floatOrNull('priceUsd')
    if (priceUsd != null) {
      const isLanded = formData.get('priceIsLanded') === 'true'
      await db.supplierPrice.upsert({
        where: { productId_supplierId: { productId: id, supplierId: activeSupplierId } },
        update: { priceUsd, isLanded },
        create: { productId: id, supplierId: activeSupplierId, priceUsd, isLanded },
      })
    } else {
      await db.supplierPrice.deleteMany({ where: { productId: id, supplierId: activeSupplierId } })
    }

    const data: Prisma.ProductUpdateInput = { ...campos, ...ajusteStock }
    const cambioFisico =
      campos.weightGrams !== actual.weightGrams || campos.dimL !== actual.dimL ||
      campos.dimA !== actual.dimA || campos.dimH !== actual.dimH
    if (cambioFisico) {
      const cfg = await getConfig()
      const rp = reprice(
        {
          priceInr: actual.priceInr,
          weightGrams: campos.weightGrams, dimL: campos.dimL, dimA: campos.dimA, dimH: campos.dimH,
          margin: actual.margin, price: Number(actual.price), priceLocked: actual.priceLocked,
        },
        cfg,
        margenPorDefecto(cfg),
      )
      Object.assign(data, rp.data)
    }
    await db.product.update({ where: { id }, data })
  } else {
    const data = {
      ...campos,
      ...ajusteStock,
      priceInr:      intOrNull('priceInr'),
      margin:        str('margin') ? parseFloat(str('margin')) / 100 : null,
      price:         toNum(str('price')) ?? 0,
      priceLocked:   formData.get('priceLocked') === 'true',
      landedCostUsd: null as number | null,
    }
    const landed = await computeLanded({
      priceInr: data.priceInr, weightGrams: data.weightGrams,
      dimL: data.dimL, dimA: data.dimA, dimH: data.dimH,
    })
    if (landed != null) data.landedCostUsd = landed
    await db.product.update({ where: { id }, data })
  }

  revalidatePath('/products')
  revalidatePath('/envios')
  revalidatePath('/groups')
  return ok()
}

// Un producto en uso no se borra (ver motivoProductoEnUso): las FK son Restrict, y antes la
// negativa de la base llegaba como un P2003 crudo — un 500 en producción. Se cuenta primero
// para decir qué la retiene, y el P2003 queda como red por si algo la toma entre el conteo y
// el borrado. `volver` es para el botón de la ficha: borrada la pieza, esa URL ya es un 404,
// así que hay que llevar al listado.
export async function deleteProduct(id: number, volver = false): Promise<ActionResult> {
  const p = await db.product.findUnique({
    where: { id },
    select: { _count: { select: { pedidoItems: true, envioLineas: true, assemblies: true } } },
  })
  // Ya la había borrado otra request: el estado que se quería es el que hay.
  if (p) {
    const { pedidoItems, envioLineas, assemblies } = p._count
    const motivo = motivoProductoEnUso({ pedidoItems, envioLineas, ensambles: assemblies })
    if (motivo) return fallo(`No se puede borrar. ${motivo}`)
    try {
      await db.product.delete({ where: { id } })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'P2003') return fallo('No se puede borrar: otra parte del sistema todavía usa esta pieza.')
      if (code !== 'P2025') throw e
    }
  }
  revalidatePath('/products')
  revalidatePath('/groups')
  if (volver) redirect('/products')
  return ok()
}
