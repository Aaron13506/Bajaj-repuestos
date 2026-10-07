import { db } from './db'
import type { BundlePiece } from './bundle'
import { construirResolver, piezasDeLinea, type LineaStock, type ResolverPieza } from './stock-piezas'
import { ENVIO_COSTEO_INCLUDE, contextoCosteo, costearAereo, costearMaritimo } from './costo-envios'

// ─────────────────────────────────────────────────────────────────────────────
// Inventario PROPIO: lo que tengo y lo que ya compré y viene, pieza por pieza.
//
// Las reglas, que son las del negocio y no un detalle de pantalla:
//
//   aquí        Product.stock. Entra cuando la línea se marca 'entregado' (aéreo) o la caja
//               se recibe (marítimo). Un conjunto entra como sus piezas (lib/stock-piezas).
//   en camino   Lo que está en una caja CONFIRMADA y todavía no llegó: las líneas de pedidos
//               propios en cajas aéreas confirmadas, y las de embarques marítimos confirmados.
//               Confirmar la caja es decidir la compra (ver confirmarCajaAerea).
//
// Nada más. Un pedido propio fuera de una caja, o una caja en BORRADOR (aérea o marítima, como
// un embarque de "planificación"), no aparece en ningún lado: ni en el valor, ni en las
// cantidades, ni al lado de las piezas en los armadores. Se arman muchos para pensar una
// compra, y mostrarlos —aunque fuera aparte— mezclaba ideas con mercancía.
//
// Lo de clientes queda afuera: ya tiene dueño y nunca pasa a ser stock.
// ─────────────────────────────────────────────────────────────────────────────

// El resolver de piezas de conjunto (lib/stock-piezas) para las que aparecen en estas
// líneas: una sola consulta al catálogo.
export async function resolverDePiezas(lineas: LineaStock[]): Promise<ResolverPieza> {
  const codes = new Set<string>()
  const names = new Set<string>()
  for (const l of lineas) {
    for (const p of l.bundleItems ?? []) {
      if (p.bajajCode) codes.add(p.bajajCode)
      else names.add(p.nameEs)
    }
  }
  if (codes.size === 0 && names.size === 0) return () => null

  const productos = await db.product.findMany({
    where: { OR: [{ bajajCode: { in: [...codes] } }, { nameEs: { in: [...names] } }] },
    select: { id: true, bajajCode: true, nameEs: true },
  })
  return construirResolver(productos)
}

export interface CajaDePieza {
  envioId: number
  nombre: string
  modo: 'aereo' | 'maritimo_cbm'
  unidades: number
}

export interface PosicionPieza {
  productId: number
  aqui: number
  caminoAereo: number
  caminoMaritimo: number
  cajas: CajaDePieza[]
}

/** Lo que el armador necesita de cada pieza: solo cantidades, serializable. */
export type PosicionesStock = Record<number, Omit<PosicionPieza, 'productId'>>

const nombreCaja = (e: { id: number; nombre: string | null; modo: string }) =>
  e.nombre ?? (e.modo === 'maritimo_cbm' ? `Embarque #${e.id}` : `Envío #${e.id}`)

// Las cantidades, sin valorar: es lo barato, y es lo que miran los armadores al lado de cada
// pieza ("aquí 2 · en camino 3"). `sinResolver` son piezas de conjuntos que no se pudieron
// identificar en el catálogo: viajan, pero no se pueden atribuir a ninguna fila.
export async function posicionesStock(): Promise<{ porProducto: Map<number, PosicionPieza>; sinResolver: number }> {
  const [enMano, itemsAereo, lineasMar] = await Promise.all([
    db.product.findMany({ where: { stock: { not: 0 } }, select: { id: true, stock: true } }),
    db.pedidoItem.findMany({
      where: {
        pedido: { tipo: 'propio' },
        shippingStatus: { not: 'entregado' },
        envio: { modo: 'aereo', estado: 'confirmado' },
      },
      select: {
        productId: true, quantity: true, bundleItems: true,
        envio: { select: { id: true, nombre: true, modo: true } },
      },
    }),
    db.envioLinea.findMany({
      where: { envio: { modo: 'maritimo_cbm', estado: 'confirmado' } },
      select: {
        productId: true, quantity: true,
        envio: { select: { id: true, nombre: true, modo: true } },
      },
    }),
  ])

  const porProducto = new Map<number, PosicionPieza>()
  const de = (productId: number) => {
    let p = porProducto.get(productId)
    if (!p) {
      p = { productId, aqui: 0, caminoAereo: 0, caminoMaritimo: 0, cajas: [] }
      porProducto.set(productId, p)
    }
    return p
  }
  const sumarEnCaja = (
    productId: number,
    unidades: number,
    envio: { id: number; nombre: string | null; modo: string },
  ) => {
    const p = de(productId)
    const modo = envio.modo === 'maritimo_cbm' ? 'maritimo_cbm' : 'aereo'
    if (modo === 'aereo') p.caminoAereo += unidades
    else p.caminoMaritimo += unidades
    const caja = p.cajas.find(c => c.envioId === envio.id)
    if (caja) caja.unidades += unidades
    else p.cajas.push({ envioId: envio.id, nombre: nombreCaja(envio), modo, unidades })
  }

  for (const pr of enMano) de(pr.id).aqui = pr.stock

  const lineas = itemsAereo.map(it => ({ ...it, bundleItems: it.bundleItems as BundlePiece[] | null }))
  const resolver = await resolverDePiezas(lineas)
  let sinResolver = 0
  for (const it of lineas) {
    if (!it.envio) continue
    const { piezas, faltan } = piezasDeLinea(it, resolver)
    sinResolver += faltan.length
    for (const pz of piezas) sumarEnCaja(pz.productId, pz.unidades, it.envio)
  }
  for (const l of lineasMar) sumarEnCaja(l.productId, l.quantity, l.envio)

  return { porProducto, sinResolver }
}

// Para pasarle a un client component (un Map no se serializa).
export async function posicionesParaArmador(): Promise<PosicionesStock> {
  const { porProducto } = await posicionesStock()
  const out: PosicionesStock = {}
  for (const [id, p] of porProducto) {
    out[id] = { aqui: p.aqui, caminoAereo: p.caminoAereo, caminoMaritimo: p.caminoMaritimo, cajas: p.cajas }
  }
  return out
}

export interface FilaInventario extends PosicionPieza {
  nameEs: string
  bajajCode: string | null
  compatibleModels: string | null
  /** aquí × costo de reposición. null = hay stock pero la pieza no tiene costo cargado. */
  valorAquiUsd: number | null
  /** Lo que cuesta lo que viene, puesto en Venezuela, según el costeo de su caja. */
  valorCaminoUsd: number
}

export interface ResumenInventario {
  filas: FilaInventario[]
  aqui: { valorUsd: number; unidades: number; productos: number; sinCosto: number }
  camino: {
    valorUsd: number
    unidades: number
    aereo: { valorUsd: number; unidades: number; cajas: number }
    maritimo: { valorUsd: number; unidades: number; cajas: number }
    /** Alguna caja se costeó con datos faltantes (sin pesar, sin factura del tramo, sin peso): es un piso. */
    incompleto: boolean
  }
  /** Piezas de conjuntos en camino que no se pudieron identificar en el catálogo. */
  sinResolver: number
}

// El inventario completo, valorado.
//
//   aquí:      costo de REPOSICIÓN actual (landedCostUsd, el mismo que fija los precios de
//              venta), no el histórico de lo que ya está en el depósito — eso pediría costeo
//              por lote. Decisión explícita.
//   en camino: el landed de cada línea según el costeo de SU caja (lib/costo-envios, el mismo
//              número que la ficha): mercancía (lo pagado si ya se cargó) + flete (el
//              facturado si ya llegó la factura) + cargos + comisiones. Antes se tomaba
//              solo lo que se le pagó al proveedor, que es la mercancía sola: en la primera
//              caja propia, un tercio de lo que de verdad cuesta.
export async function resumenInventario(): Promise<ResumenInventario> {
  const [{ porProducto, sinResolver }, cajas] = await Promise.all([
    posicionesStock(),
    db.envio.findMany({
      where: {
        estado: 'confirmado',
        OR: [
          { modo: 'aereo', items: { some: { pedido: { tipo: 'propio' }, shippingStatus: { not: 'entregado' } } } },
          { modo: 'maritimo_cbm', lineas: { some: {} } },
        ],
      },
      include: ENVIO_COSTEO_INCLUDE,
    }),
  ])

  // Valor en camino por producto, y por ruta para los totales.
  const valorCamino = new Map<number, number>()
  const sumarValor = (productId: number | null, usd: number) => {
    if (productId == null || !Number.isFinite(usd)) return
    valorCamino.set(productId, (valorCamino.get(productId) ?? 0) + usd)
  }
  let valorAereo = 0
  let valorMar = 0
  let cajasAereo = 0
  let cajasMar = 0
  let incompleto = false

  const ctx = await contextoCosteo(cajas)
  for (const e of cajas) {
    if (e.modo === 'maritimo_cbm') {
      // La caja entera es mercancía propia: su landed (con el mínimo facturable y el FOB) se
      // reparte entre las piezas en proporción a lo que cada una cuesta por sí sola.
      const m = costearMaritimo(e, ctx)
      const base = m.resumen.landedUsd
      for (const pz of m.resumen.piezas) {
        sumarValor(pz.productId, base > 0 ? m.landedUsd * (pz.landedUsd / base) : 0)
      }
      valorMar += m.landedUsd
      cajasMar++
      if (m.resumen.sinMedidas > 0) incompleto = true
      continue
    }

    const { calc, itemIdDeLinea } = costearAereo(e, ctx)
    const propioEnCamino = new Set(
      e.items.filter(it => it.pedido.tipo === 'propio' && it.shippingStatus !== 'entregado').map(it => it.id),
    )
    let suma = 0
    calc.lines.forEach((l, i) => {
      if (!propioEnCamino.has(itemIdDeLinea[i])) return
      suma += l.landedUsd
      sumarValor(l.productId, l.landedUsd)
      if (l.missingWeight) incompleto = true
    })
    valorAereo += suma
    cajasAereo++
    if (!calc.caja.medido || calc.tramo?.faltaCosto === true) incompleto = true
  }

  const ids = [...new Set([...porProducto.keys(), ...valorCamino.keys()])]
  const productos = ids.length > 0
    ? await db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, nameEs: true, bajajCode: true, compatibleModels: true, landedCostUsd: true },
      })
    : []

  const filas: FilaInventario[] = []
  let aquiValor = 0
  let aquiUnidades = 0
  let aquiProductos = 0
  let sinCosto = 0
  let unidadesAereo = 0
  let unidadesMar = 0

  for (const pr of productos) {
    const pos = porProducto.get(pr.id) ?? { productId: pr.id, aqui: 0, caminoAereo: 0, caminoMaritimo: 0, cajas: [] }
    let valorAquiUsd: number | null = 0
    if (pos.aqui > 0) {
      aquiProductos++
      aquiUnidades += pos.aqui
      if (pr.landedCostUsd == null) {
        valorAquiUsd = null
        sinCosto++
      } else {
        valorAquiUsd = pos.aqui * parseFloat(pr.landedCostUsd.toString())
        aquiValor += valorAquiUsd
      }
    }
    unidadesAereo += pos.caminoAereo
    unidadesMar += pos.caminoMaritimo
    filas.push({
      ...pos,
      nameEs: pr.nameEs,
      bajajCode: pr.bajajCode,
      compatibleModels: pr.compatibleModels,
      valorAquiUsd,
      valorCaminoUsd: valorCamino.get(pr.id) ?? 0,
    })
  }

  return {
    filas,
    aqui: { valorUsd: aquiValor, unidades: aquiUnidades, productos: aquiProductos, sinCosto },
    camino: {
      // Los totales salen de las cajas, no de sumar filas: una pieza que no resolvió a ningún
      // producto igual costó, y tiene que estar en la plata aunque no tenga fila.
      valorUsd: valorAereo + valorMar,
      unidades: unidadesAereo + unidadesMar,
      aereo: { valorUsd: valorAereo, unidades: unidadesAereo, cajas: cajasAereo },
      maritimo: { valorUsd: valorMar, unidades: unidadesMar, cajas: cajasMar },
      incompleto,
    },
    sinResolver,
  }
}
