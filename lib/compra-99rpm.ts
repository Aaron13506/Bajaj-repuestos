import type { BundlePiece } from './bundle'
import { formatModels, toModelIds } from './modelo'
import { limpiarNombre } from './utils'

/**
 * Lista de compra de 99rpm, ordenada por ENSAMBLE en vez de por SKU.
 *
 * A 99rpm no se le compra por código: se entra a la página del ensamble, se tildan las
 * piezas que hacen falta y se pone UN `Qty` que multiplica TODA la selección. La cantidad
 * de cada línea la fija el despiece (`ProductComponent.quantity`) y no se elige: el sello
 * que va de a 4 entra de a 4, y para tener 8 hay que poner Qty 2.
 *
 * Una lista consolidada por SKU —que es la correcta para Garuda o cualquier proveedor que
 * cotiza por pieza suelta— obliga entonces a entrar al mismo ensamble una vez por código,
 * buscando a mano de dónde salió cada uno. Este módulo la da vuelta: agrupa por ensamble y,
 * adentro, arma un bloque por cada `Qty` distinto. Cada bloque es exactamente un
 * "Add to cart", y cada pieza cae en uno solo — nunca hay que sumar dos bloques de cabeza.
 *
 * El mismo SKU puede aparecer en dos ensambles distintos y acá aparece dos veces, una en
 * cada uno: son dos páginas distintas de 99rpm y dos compras distintas. Consolidarlo
 * ahorraría una línea en la pantalla y costaría tener que decidir, parado frente al
 * catálogo, de cuál de los dos ensambles sacarlo.
 */

// Una pieza tildada en la página del ensamble.
export interface PiezaTilde {
  sku: string | null
  name: string
  // Subgrupo del despiece ("Fasteners", "Shaft"): es el encabezado bajo el que aparece
  // el checkbox en 99rpm, así que ordena la búsqueda visual.
  groupName: string
  // Lo que entra por tilde: el "4 x" de la línea. Es dato del despiece, no elegible.
  base: number
  // base × qty del bloque — lo que realmente vas a recibir.
  unidades: number
  // Bajaj dejó de fabricarla: en 99rpm el checkbox sale deshabilitado (NLS).
  descontinuada: boolean
}

// Un bloque = una pasada por el ensamble = un "Add to cart": tildás estas piezas y ponés
// este Qty.
export interface BloqueCompra {
  qty: number
  piezas: PiezaTilde[]
  unidades: number
}

export interface EnsambleCompra {
  assemblyId: number
  nombre: string
  sku: string | null
  // Las motos del ensamble ya colapsadas por familia (formatModels); '' si no tiene.
  modelo: string
  bloques: BloqueCompra[]
  // De qué presupuestos salió, para saber a quién le estás comprando.
  pedidos: string[]
  unidades: number
  avisos: string[]
}

export interface CompraPorEnsamble {
  ensambles: EnsambleCompra[]
  // Líneas que no traen desglose (una pieza cargada suelta, o un presupuesto viejo). No
  // deberían existir —todo se arma entrando por el ensamble— pero si aparece una, se
  // muestra aparte en vez de desaparecer de la lista de compra.
  sinEnsamble: { sku: string | null; name: string; qty: number }[]
  totalUnidades: number
  totalBloques: number
}

// Una línea pendiente del envío, ya filtrada a las que se le compran a 99rpm.
export interface LineaPendiente99 {
  assemblyId: number
  assemblyName: string
  assemblySku: string | null
  compatibleModels: string | null
  // PedidoItem.quantity: cuántas veces se pidió el conjunto entero.
  quantity: number
  bundleItems: BundlePiece[] | null
  clientName: string
}

// El despiece tal como lo publica 99rpm: cuánto entra por tilde de cada pieza del ensamble.
export interface BaseDespiece {
  parentId: number
  bajajCode: string | null
  nameEs: string
  quantity: number
  groupName: string
  sortOrder: number
  descontinuada: boolean
}

// Clave de una pieza dentro de un ensamble. El código Bajaj manda; el nombre es el
// respaldo para las piezas sin código, que en el snapshot del presupuesto existen.
const clavePieza = (sku: string | null, name: string) => sku ?? `n:${limpiarNombre(name).toLowerCase()}`

interface Acumulado {
  sku: string | null
  name: string
  groupName: string
  sortOrder: number
  base: number
  descontinuada: boolean
  // Cuántos tildes hacen falta en total. Entero salvo que el presupuesto pida una
  // cantidad que no es múltiplo de la base, que es justamente lo que hay que avisar.
  tildes: number
  // Lo que pedía el presupuesto, para poder decir cuánto sobra al redondear.
  pedido: number
}

/**
 * Arma la lista. `lineas` son las líneas pendientes de 99rpm del envío y `bases` el
 * despiece de los ensambles que aparecen en ellas.
 *
 * Dos líneas del mismo ensamble (dos presupuestos que piden el mismo conjunto) se suman
 * antes de partir en bloques: son una sola visita a la página, con el Qty sumado.
 */
export function armarCompra99rpm(
  lineas: LineaPendiente99[],
  bases: BaseDespiece[],
): CompraPorEnsamble {
  const despiece = new Map<string, BaseDespiece>()
  for (const b of bases) {
    despiece.set(`${b.parentId}|${clavePieza(b.bajajCode, b.nameEs)}`, b)
  }

  interface EnCurso {
    linea: LineaPendiente99
    piezas: Map<string, Acumulado>
    pedidos: Set<string>
    avisos: string[]
  }
  const porEnsamble = new Map<number, EnCurso>()
  const sinEnsamble = new Map<string, { sku: string | null; name: string; qty: number }>()

  for (const l of lineas) {
    if (!l.bundleItems || l.bundleItems.length === 0) {
      const k = clavePieza(l.assemblySku, l.assemblyName)
      const prev = sinEnsamble.get(k)
      if (prev) prev.qty += l.quantity
      else sinEnsamble.set(k, { sku: l.assemblySku, name: limpiarNombre(l.assemblyName), qty: l.quantity })
      continue
    }

    let e = porEnsamble.get(l.assemblyId)
    if (!e) {
      e = { linea: l, piezas: new Map(), pedidos: new Set(), avisos: [] }
      porEnsamble.set(l.assemblyId, e)
    }
    e.pedidos.add(l.clientName)

    for (const bp of l.bundleItems) {
      const k = clavePieza(bp.bajajCode, bp.nameEs)
      const d = despiece.get(`${l.assemblyId}|${k}`)
      // Sin fila en el despiece no hay con qué saber de a cuánto se vende: se toma la
      // cantidad del presupuesto como si fuera la base (un tilde). Se avisa, porque
      // significa que el ensamble cambió en 99rpm desde que se armó el presupuesto.
      const base = d?.quantity && d.quantity > 0 ? d.quantity : bp.quantity
      if (!d) {
        e.avisos.push(
          `${bp.bajajCode ?? bp.nameEs} ya no figura en el despiece de este ensamble — revisá la página antes de tildarlo.`,
        )
      }
      if (base <= 0) continue

      const total = bp.quantity * l.quantity
      let acc = e.piezas.get(k)
      if (!acc) {
        acc = {
          sku: bp.bajajCode,
          name: limpiarNombre(d?.nameEs ?? bp.nameEs),
          groupName: d?.groupName || bp.groupName || '',
          sortOrder: d?.sortOrder ?? 0,
          base,
          descontinuada: d?.descontinuada ?? false,
          tildes: 0,
          pedido: 0,
        }
        e.piezas.set(k, acc)
      }
      acc.tildes += total / base
      acc.pedido += total
    }
  }

  const ensambles: EnsambleCompra[] = []
  for (const [assemblyId, e] of porEnsamble) {
    const avisos = [...e.avisos]

    // Un tilde es indivisible: si el presupuesto pide 6 de algo que va de a 4, hay que
    // comprar 8. Se redondea hacia arriba —comprar de menos deja el pedido incompleto— y
    // se avisa con los dos números, porque el sobrante se paga y viaja.
    const piezas = Array.from(e.piezas.values()).map(p => {
      const tildes = Math.ceil(p.tildes - 1e-9)
      const unidades = tildes * p.base
      if (unidades !== p.pedido) {
        avisos.push(
          `${p.sku ?? p.name}: el presupuesto pide ${p.pedido} y 99rpm la vende de a ${p.base} — se compran ${unidades} (sobran ${unidades - p.pedido}).`,
        )
      }
      if (p.descontinuada) {
        avisos.push(`${p.sku ?? p.name} está descontinuada: en 99rpm el checkbox va a estar deshabilitado.`)
      }
      return { ...p, tildes, unidades }
    })

    // Un bloque por cada Qty distinto. Es el mínimo de pasadas por el ensamble en el que
    // cada pieza aparece una sola vez: repartirla entre bloques ahorraría alguna pasada
    // en casos raros, a cambio de tener que sumar de cabeza cuánto lleva cada pieza.
    const porQty = new Map<number, PiezaTilde[]>()
    for (const p of piezas) {
      if (p.tildes <= 0) continue
      const arr = porQty.get(p.tildes) ?? []
      arr.push({
        sku: p.sku,
        name: p.name,
        groupName: p.groupName,
        base: p.base,
        unidades: p.unidades,
        descontinuada: p.descontinuada,
      })
      porQty.set(p.tildes, arr)
    }

    const bloques: BloqueCompra[] = Array.from(porQty.entries())
      .map(([qty, ps]) => ({
        qty,
        // Mismo orden que la página de 99rpm: por subgrupo y, dentro, como los lista el
        // despiece. Así se tildan de arriba hacia abajo sin buscar.
        piezas: ps.sort((a, b) =>
          a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name)
        ),
        unidades: ps.reduce((s, p) => s + p.unidades, 0),
      }))
      .sort((a, b) => a.qty - b.qty)

    const modelo = formatModels(toModelIds(e.linea.compatibleModels))
    ensambles.push({
      assemblyId,
      nombre: limpiarNombre(e.linea.assemblyName),
      sku: e.linea.assemblySku,
      modelo,
      bloques,
      pedidos: Array.from(e.pedidos).sort(),
      unidades: bloques.reduce((s, b) => s + b.unidades, 0),
      avisos: Array.from(new Set(avisos)),
    })
  }

  // Por moto y después por nombre: se compra recorriendo el catálogo de una moto a la vez.
  ensambles.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.nombre.localeCompare(b.nombre))

  return {
    ensambles,
    sinEnsamble: Array.from(sinEnsamble.values()).sort((a, b) => a.name.localeCompare(b.name)),
    totalUnidades: ensambles.reduce((s, e) => s + e.unidades, 0),
    totalBloques: ensambles.reduce((s, e) => s + e.bloques.length, 0),
  }
}
