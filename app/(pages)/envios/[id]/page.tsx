import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import EnvioItemsTable, { type EnvioItemRow } from '@/components/EnvioItemsTable'
import PendingButton from '@/components/PendingButton'
import FormConResultado from '@/components/FormConResultado'
import SueltoPedido, { type LineaSuelta, type EnOtraCaja } from '@/components/SueltoPedido'
import PendientesCompraButton, {
  type PendienteGrupo,
  type PendienteRow,
} from '@/components/PendientesCompraButton'
import RegistrarPagoProveedorForm from '@/components/RegistrarPagoProveedorForm'
import RegistrarCompraPicker from '@/components/RegistrarCompraPicker'
import { METODOS_PAGO_EGRESO } from '@/lib/pagos'
import { limpiarNombre } from '@/lib/utils'
import { calcEnvio, type EnvioItemInput, type ConfigMap, type ProveedorEnvio } from '@/lib/calc'
import { inboundDe, inboundMeta } from '@/lib/inbound'
import { modoDeEnvio, MODOS } from '@/lib/modo'
import EnvioMaritimo from './maritimo'
import { lookupDeConjuntos, expandCostPieces, repartirCostoReal } from '@/lib/envio-build'
import { financiamientoEnvio, type FinanciamientoEnvio } from '@/lib/financiamiento-envio'
import FleteRealCard, { type FilaFlete } from '@/components/FleteRealCard'
import { TRAMOS_FLETE, CATEGORIAS_FLETE, estadoFlete } from '@/lib/flete-real'
import { itemsSinCostoRealDeEnvio, CATEGORIAS_PAGO_PROVEEDOR } from '@/lib/movimientos'
import type { BundlePiece } from '@/lib/bundle'
import { toConfigMap } from '@/lib/config'
import { armarCompra99rpm } from '@/lib/compra-99rpm'
import { cabeceraDeLinea, nombreEnsamble } from '@/lib/linea-pedido'
import { registrarCompra } from '@/app/(pages)/contabilidad/actions'
import {
  assignPedido,
  assignItems,
  assignAllConfirmados,
  removePedido,
  deleteEnvio,
  saveCostosProveedor,
  saveMedidasCaja,
  guardarFleteReal,
  pagarFlete,
  deshacerPagoFlete,
  saveItemChanges,
  registrarPagoProveedor,
  confirmarCajaAerea,
  volverCajaABorrador,
} from '../actions'

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`
// El m³ se muestra con 3 decimales: una pieza suelta ronda los 0.00x m³ y con 2
// decimales todo el catálogo se vería como "0.00".
const m3 = (n: number) => `${n.toFixed(3)} m³`
// Dónde estás parado en la curva de la tarifa.
//
// El $/kg NO tiene un mínimo en el medio: baja siempre, y lo más barato por kilo está en el
// tope de la caja. Lo que pasa a los 11 kg es que deja de bajar RÁPIDO — de ahí para arriba
// la mejora es chica. Los textos hablaban de un "punto dulce" en 11 kg como si fuera el
// óptimo, y encima cotizaban en INR/kg, de cuando la tarifa se guardaba en rupias: hoy la
// tabla es en USD y el tramo aéreo no pasa por `inr_usd_rate`, así que esos números no
// correspondían a nada que se pudiera verificar en la misma pantalla.
//
// Por eso el $/kg que se muestra es el REAL de esta caja (`costPerKgUsd` del breakdown) y no
// una constante escrita a mano: una tarifa hardcodeada envejece con el próximo scrape y
// nadie se entera.
function airTierHint(
  chargeableKg: number,
  costPerKgUsd = 0,
  cajas = 1,
  capKg: number | null = null,
): { tone: 'good' | 'info' | 'warn'; text: string } | null {
  if (chargeableKg <= 0) return null
  const perKg = `$${costPerKgUsd.toFixed(2)}/kg`

  // Pasado el tope por caja el consejo se da vuelta: sumar kilos ya no abarata nada, porque
  // el kilo 23 no entra en un escalón más alto — arranca una caja nueva desde la parte cara
  // de la curva. Decir "estás en el tramo más eficiente" acá empuja para el lado que cuesta.
  if (cajas > 1 && capKg != null) {
    return {
      tone: 'warn',
      text: `Pasaste el tope de ${capKg} kg por caja: van ${cajas} cajas y el flete es la suma de las ` +
            `${cajas}, ${perKg} en promedio. Partir encarece siempre —los primeros kilos de cada caja ` +
            `son los más caros—, así que conviene una sola caja llena antes que dos a medio llenar.`,
    }
  }
  if (capKg != null && chargeableKg > capKg - 1 && chargeableKg <= capKg) {
    return {
      tone: 'good',
      text: `Caja llena: ${chargeableKg.toFixed(1)} de ${capKg} kg, a ${perKg} — lo más barato por kilo que da la tabla. Un kilo más y son dos cajas.`,
    }
  }
  if (chargeableKg < 11) {
    return {
      tone: 'info',
      text: `Vas a ${perKg}, en la parte cara de la curva. Te faltan ${(11 - chargeableKg).toFixed(1)} kg para los 11, ` +
            `donde el flete por kilo cae fuerte; de ahí para arriba sigue bajando pero ya poco.`,
    }
  }
  if (chargeableKg < 20) {
    return {
      tone: 'info',
      text: `Vas a ${perKg}, ya en la parte plana de la curva: sumar kilos sigue abaratando, pero de a poco. ` +
            `Lo más barato por kilo está en el tope de la caja${capKg != null ? ` (${capKg} kg)` : ''}.`,
    }
  }
  return {
    tone: 'good',
    text: capKg != null
      ? `${perKg}: lo más barato por kilo que da la tabla. Te quedan ${(capKg - chargeableKg).toFixed(1)} kg antes del tope de la caja.`
      : `${perKg}: lo más barato por kilo que da la tabla.`,
  }
}

export default async function EnvioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  // Los dos carriles son documentos distintos, no variantes del mismo: el marítimo lleva
  // mercancía propia (EnvioLinea) y se arma pieza por pieza, el aéreo agrupa pedidos de
  // cliente. Se bifurca acá arriba en vez de llenar la ficha de condicionales.
  const ruta = await db.envio.findUnique({ where: { id }, select: { modo: true } })
  if (!ruta) notFound()
  if (ruta.modo === 'maritimo_cbm') return <EnvioMaritimo envioId={id} />

  const [envio, cfgRows, sinAsignar, suppliers, pedidosCaja, despiece99, repartidos, egresosCaja, itemsPendientesCosto, pagosFlete] = await Promise.all([
    db.envio.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: true, ensamble: true, pedido: true, supplier: true },
          orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
        },
        // El proveedor de la caja: decide el precio de las piezas, cómo se cobra el tramo
        // a USA y qué etapas tiene la ruta de todo lo que va adentro.
        supplier: { select: { id: true, name: true, origen: true, inbound: true } },
      },
    }),
    db.config.findMany(),
    db.pedidoItem.findMany({
      where: { envioId: null },
      include: {
        product: { select: { nameEs: true, bajajCode: true, discontinuedAt: true } },
        ensamble: { select: { nameEs: true, nameEn: true } },
        pedido: true,
      },
      orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
    }),
    db.supplier.findMany({
      select: { id: true, name: true, origen: true, inbound: true },
      orderBy: { name: 'asc' },
    }),
    // Los pedidos que tienen alguna línea en esta caja, CON todos sus ítems (no solo los
    // de acá): el adelanto se pactó contra el pedido entero, así que la deuda solo se
    // puede leer contra su total completo. Ver cobranzaEnvio.
    db.pedido.findMany({
      where: { items: { some: { envioId: id } } },
      select: {
        id: true,
        clientName: true,
        tipo: true,
        status: true,
        depositUsd: true,
        items: { select: { salePrice: true, quantity: true, envioId: true } },
      },
    }),
    // El despiece de los ensambles que todavía hay que comprarle a 99rpm: cuántas unidades
    // entran por cada tilde. Es el dato que el snapshot del presupuesto NO tiene —ahí la
    // cantidad puede haberse editado a mano— y sin él no se sabe qué Qty poner.
    //
    // Va en el mismo Promise.all aunque dependa de qué ítems tiene la caja: filtrar por la
    // relación lo resuelve en una sola consulta, en vez de encadenar un round-trip más.
    db.ensambleComponente.findMany({
      where: {
        ensamble: { pedidoItems: { some: { envioId: id, supplierId: null, shippingStatus: 'pendiente' } } },
      },
      select: {
        ensambleId: true,
        quantity: true,
        groupName: true,
        sortOrder: true,
        product: { select: { bajajCode: true, nameEs: true, discontinuedAt: true } },
      },
    }),
    // Dónde viaja el resto de los presupuestos que todavía tienen líneas sueltas. Sin esto
    // el desglose miente por omisión: muestra 3 líneas libres sin decir que las otras 7 ya
    // están en otra caja, y parece un presupuesto chico en vez de uno repartido.
    db.pedidoItem.findMany({
      where: {
        envioId: { not: null },
        pedido: { items: { some: { envioId: null } } },
      },
      select: { pedidoId: true, envio: { select: { id: true, nombre: true } } },
    }),
    // Plata que ya salió de la cuenta contra esta caja (ver registrarPagoProveedor):
    // "pagado" del giro se calcula en vivo sumando esto, nunca se cachea en Envio. Solo lo
    // que salda lo que se le debe al PROVEEDOR (mercancía, tramo, comisión del giro): un
    // flete anotado contra la caja se le pagó a Shoppre o a la naviera, y contarlo acá
    // reducía una deuda que sigue viva. Es la misma definición que usa cuentasPorPagar.
    db.movimiento.aggregate({
      where: { envioId: id, tipo: 'egreso', categoria: { in: [...CATEGORIAS_PAGO_PROVEEDOR] } },
      _sum: { monto: true },
    }),
    // Piezas de ESTA caja sin costRealUsd cargado, para el picker de "cuánto pagué de
    // verdad" — corregir peso/dimensión de la caja no dice cuánto costó lo de adentro.
    itemsSinCostoRealDeEnvio(id),
    // Los pagos de flete de esta caja: el estado "pagado" de cada tramo sale del libro, nunca de
    // un campo en Envio (un pago borrado desde contabilidad no puede dejar la ficha mintiendo).
    db.movimiento.findMany({
      where: { envioId: id, tipo: 'egreso', categoria: { in: [...CATEGORIAS_FLETE] } },
      select: { id: true, fecha: true, monto: true, metodoPago: true, categoria: true },
      orderBy: [{ fecha: 'asc' }, { id: 'asc' }],
    }),
  ])

  if (!envio) notFound()

  // Solo lo que esta caja necesita, no el catálogo entero (~5.8k filas) ni los precios de
  // todos los proveedores: las piezas de sus conjuntos, y el precio de cada línea con SU
  // proveedor. Es una vuelta más a la base, pero baja filas por miles; no se puede pedir
  // antes porque depende de qué conjuntos trae la caja.
  const lookup = await lookupDeConjuntos(envio.items.map(it => it.bundleItems as BundlePiece[] | null))
  const idsPrecio = new Set<number>(envio.items.flatMap(it => (it.productId != null ? [it.productId] : [])))
  for (const it of envio.items) {
    for (const bp of (it.bundleItems as BundlePiece[] | null) ?? []) {
      const pid = lookup(bp.bajajCode, bp.nameEs)?.id
      if (pid != null) idsPrecio.add(pid)
    }
  }
  const idsProveedor = [...new Set(envio.items.map(it => it.supplierId).filter((x): x is number => x != null))]
  const supplierPrices = idsProveedor.length
    ? await db.supplierPrice.findMany({
        where: { supplierId: { in: idsProveedor }, productId: { in: [...idsPrecio] } },
        select: { productId: true, supplierId: true, priceUsd: true },
      })
    : []

  const pagadoProveedor = parseFloat((egresosCaja._sum.monto ?? 0).toString())

  const cfg = toConfigMap(cfgRows)

  // Precio del proveedor por (proveedor, producto): cuando la línea se compró a un
  // proveedor puntual, ese USD es el costo real y le gana al priceInr del catálogo.
  const precioProveedor = new Map(
    supplierPrices.map(sp => [`${sp.supplierId}:${sp.productId}`, parseFloat(sp.priceUsd.toString())])
  )

  // Aplanar todas las piezas del envío. Los conjuntos se expanden a sus piezas reales
  // para costearlos por las piezas que llevan, no por el ensamble entero. Cada pieza
  // hereda el origen y el isLanded de SU línea de pedido: eso define por qué tramo
  // entra y si viaja o no en esta caja.
  const inrUsdPieza = parseFloat(cfg.inr_usd_rate ?? '95')
  const allPieces = envio.items.flatMap(it => {
    const piezas = expandCostPieces(
      it.product,
      it.quantity,
      it.bundleItems as BundlePiece[] | null,
      lookup,
    )
    // Lo pagado de verdad por la línea manda sobre el catálogo: se reparte entre sus piezas
    // en proporción a lo que cada una costaba.
    const reales = repartirCostoReal(
      it.costRealUsd != null ? parseFloat(it.costRealUsd.toString()) : null,
      piezas.map(p => {
        const pu = it.supplierId != null && p.productId != null
          ? precioProveedor.get(`${it.supplierId}:${p.productId}`) ?? null
          : null
        return (pu ?? (p.priceInr ?? 0) / inrUsdPieza) * p.quantity
      }),
    )
    return piezas.map((piece, idx) => ({
      ...piece,
      costoRealUsd: reales[idx],
      itemId: it.id,
      pedidoId: it.pedidoId,
      origen: (it.origen === 'china' ? 'china' : 'india') as 'india' | 'china',
      // El snapshot de la línea manda sobre el proveedor actual de la caja: lo que ya se
      // compró conserva la vía con la que se compró. En una caja armada normalmente todas
      // coinciden con el proveedor de la caja, porque lo heredan al entrar.
      inbound: inboundDe(it.origen, it.inbound),
      isLanded: it.isLanded,
      shippingStatus: it.shippingStatus,
      supplierId: it.supplierId,
      supplierName: it.supplier?.name ?? null,
      priceUsd: it.supplierId != null && piece.productId != null
        ? precioProveedor.get(`${it.supplierId}:${piece.productId}`) ?? null
        : null,
    }))
  })

  const items: EnvioItemInput[] = allPieces.map(p => ({
    costoRealUsd: p.costoRealUsd,
    pedidoId: p.pedidoId,
    productId: p.productId,
    name: p.name,
    weightGrams: p.weightGrams,
    dimL: p.dimL,
    dimA: p.dimA,
    dimH: p.dimH,
    priceInr: p.priceInr,
    priceUsd: p.priceUsd,
    quantity: p.quantity,
    origen: p.origen,
    inbound: p.inbound,
    supplierId: p.supplierId,
    isLanded: p.isLanded,
  }))

  // El proveedor de la caja y los montos que nadie puede derivar: lo que facturó por el
  // tramo a USA (si despacha él) y las dos comisiones del giro con el que se le pagó.
  const dec = (v: { toString(): string } | null) => (v != null ? parseFloat(v.toString()) : null)
  const tramoUsd = dec(envio.tramoUsd)
  const comisionSalienteUsd = dec(envio.comisionSalienteUsd)
  const comisionEntranteUsd = dec(envio.comisionEntranteUsd)
  const inboundCaja = inboundDe(envio.supplier?.origen, envio.supplier?.inbound)
  const proveedor: ProveedorEnvio | null = envio.supplier
    ? {
        supplierId: envio.supplier.id,
        nombre: envio.supplier.name,
        tramoUsd,
        comisionSalienteUsd,
        comisionEntranteUsd,
      }
    : null
  // El envío se costea con SU modo (snapshot al crearlo), no con el modo global activo:
  // una caja aérea ya armada sigue costeándose como aérea aunque hoy operes en CBM.
  const modoEnvio = modoDeEnvio(envio.modo)
  const esCbm = modoEnvio === 'maritimo_cbm'
  // La caja como la pesó y midió el transportista. Si está cargada manda ella y reemplaza
  // a la suma de las piezas: lo que se factura es lo que leyó la balanza.
  const medidas = {
    pesoKg: envio.pesoRealKg != null ? parseFloat(envio.pesoRealKg.toString()) : null,
    dimL: envio.cajaL,
    dimA: envio.cajaA,
    dimH: envio.cajaH,
  }
  // Lo que en verdad facturaron los transportistas. Si ya se cargó, pisa al estimado de
  // tabla en el landed y el margen — igual que `medidas` con el peso, ver calcEnvio.
  const costoRealAereo = envio.shippingCostRealAereo != null ? parseFloat(envio.shippingCostRealAereo.toString()) : null
  const costoRealMaritimo = envio.shippingCostRealMaritimo != null ? parseFloat(envio.shippingCostRealMaritimo.toString()) : null
  const calc = calcEnvio(items, cfg, {
    proveedor,
    modo: modoEnvio,
    medidas,
    fleteFacturado: { aereoUsd: costoRealAereo, maritimoUsd: costoRealMaritimo },
  })
  // El mismo envío costeado por la suma de las piezas y el estimado de tabla, para ver
  // cuánto se le escapaba al catálogo y a la tarifa. Solo tiene sentido cuando hay una caja
  // real contra la cual compararlo.
  const calcNeto = calc.caja.medido
    ? calcEnvio(items, cfg, { proveedor, modo: modoEnvio })
    : null

  // Contenido de la caja consolidado por SKU (o nombre si no tiene SKU), separado por origen.
  // Cada pieza se valora como la valora el costeo: el precio del proveedor de su línea (USD)
  // si lo tiene y, si no, el ₹ de 99rpm. Mostrar siempre el ₹ del catálogo daba, en una caja
  // de Garuda, un total que no era lo que se iba a pagar.
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  interface BuyRow {
    sku: string | null
    name: string
    qty: number
    unit: number | null
    moneda: 'INR' | 'USD'
    totalUsd: number
    // Parte del total que está en rupias, para poder decir cuántas hay que cambiar.
    totalInr: number
    missingPrice: boolean
  }
  const buildBuyList = (origen: 'india' | 'china') => {
    const buyMap = new Map<string, BuyRow>()
    for (const p of allPieces) {
      if (p.origen !== origen) continue
      const key = p.sku ?? p.name
      let row = buyMap.get(key)
      if (!row) {
        row = { sku: p.sku, name: p.name, qty: 0, unit: null, moneda: 'INR', totalUsd: 0, totalInr: 0, missingPrice: false }
        buyMap.set(key, row)
      }
      row.qty += p.quantity
      if (p.priceUsd != null) {
        if (row.unit == null) { row.unit = p.priceUsd; row.moneda = 'USD' }
        row.totalUsd += p.priceUsd * p.quantity
      } else if (p.priceInr != null) {
        if (row.unit == null) { row.unit = p.priceInr; row.moneda = 'INR' }
        row.totalInr += p.priceInr * p.quantity
        row.totalUsd += (p.priceInr * p.quantity) / inrUsd
      } else {
        row.missingPrice = true
      }
    }
    return Array.from(buyMap.values()).sort((a, b) => b.totalUsd - a.totalUsd)
  }
  const buyIndia = buildBuyList('india')
  const buyChina = buildBuyList('china')
  const buyTotalUsd = buyIndia.reduce((s, r) => s + r.totalUsd, 0)
  const buyTotalInr = buyIndia.reduce((s, r) => s + r.totalInr, 0)
  const buyUnits = buyIndia.reduce((s, r) => s + r.qty, 0)

  // Lo que TODAVÍA falta comprar: las mismas piezas, pero solo de las líneas que siguen
  // en 'pendiente'. La lista de compra de arriba es el envío entero (incluye lo ya
  // comprado); esta es la que se lleva al proveedor. Se parte por proveedor porque cada
  // uno es una orden distinta, y dentro de cada uno se consolida por SKU: si tres
  // presupuestos piden la misma pastilla, se pide una sola vez.
  const pendMap = new Map<string, PendienteGrupo>()
  for (const p of allPieces) {
    if (p.shippingStatus !== 'pendiente') continue
    const gk = p.supplierId != null ? `s${p.supplierId}` : `base-${p.origen}`
    let grupo = pendMap.get(gk)
    if (!grupo) {
      grupo = {
        key: gk,
        proveedor: p.supplierName ?? '99rpm (base)',
        origen: p.origen,
        rows: [],
      }
      pendMap.set(gk, grupo)
    }
    const key = p.sku ?? p.name
    let row = grupo.rows.find(r => (r.sku ?? r.name) === key)
    if (!row) {
      row = {
        sku: p.sku,
        name: limpiarNombre(p.name),
        qty: 0,
        unitInr: p.priceInr,
        unitUsd: p.priceUsd,
        isLanded: p.isLanded,
      }
      grupo.rows.push(row)
    }
    row.qty += p.quantity
    if (row.unitInr == null) row.unitInr = p.priceInr
    if (row.unitUsd == null) row.unitUsd = p.priceUsd
  }
  // Lo pendiente de 99rpm, reordenado por ENSAMBLE. A 99rpm no se le compra por código: se
  // entra a la página del conjunto, se tildan las piezas y se pone un Qty que multiplica
  // toda la selección. La lista consolidada por SKU es la correcta para los proveedores que
  // cotizan por pieza, y la peor posible acá — obliga a abrir el mismo ensamble una vez por
  // código. Ver lib/compra-99rpm.ts.
  const compra99datos = armarCompra99rpm(
    envio.items
      .filter(it => it.supplierId == null && it.shippingStatus === 'pendiente' && it.origen !== 'china')
      .map(it => {
        const cab = cabeceraDeLinea(it)
        return {
          ensambleId: it.ensambleId,
          assemblyName: cab.nameEs,
          assemblySku: cab.bajajCode,
          compatibleModels: cab.compatibleModels,
          quantity: it.quantity,
          bundleItems: it.bundleItems as BundlePiece[] | null,
          clientName: it.pedido.clientName,
        }
      }),
    despiece99.map(c => ({
      ensambleId: c.ensambleId,
      bajajCode: c.product.bajajCode,
      nameEs: c.product.nameEs,
      quantity: c.quantity,
      groupName: c.groupName,
      sortOrder: c.sortOrder,
      descontinuada: c.product.discontinuedAt != null,
    })),
  )
  // La clave con la que `pendMap` agrupa lo de 99rpm sin proveedor puntual.
  const compra99 = compra99datos.ensambles.length > 0 || compra99datos.sinEnsamble.length > 0
    ? { key: 'base-india', datos: compra99datos }
    : null

  const costoFila = (r: PendienteRow) =>
    r.unitUsd != null ? r.unitUsd * r.qty : (r.unitInr ?? 0) * r.qty / inrUsd
  // India primero (es la orden grande y la que manda el peso cobrable), y dentro, el
  // proveedor más caro arriba.
  const pendientes = Array.from(pendMap.values())
    .map(g => ({ ...g, rows: [...g.rows].sort((a, b) => costoFila(b) - costoFila(a)) }))
    .sort((a, b) => {
      if (a.origen !== b.origen) return a.origen === 'india' ? -1 : 1
      return b.rows.reduce((s, r) => s + costoFila(r), 0) - a.rows.reduce((s, r) => s + costoFila(r), 0)
    })

  // Venta y landed, agregados por línea de pedido para la tabla de arriba.
  const saleByItem = new Map<number, number>()
  for (const it of envio.items) {
    saleByItem.set(it.id, parseFloat(it.salePrice.toString()) * it.quantity)
  }

  const landedByItem = new Map<number, number>()
  for (let i = 0; i < calc.lines.length; i++) {
    const itemId = allPieces[i].itemId
    landedByItem.set(itemId, (landedByItem.get(itemId) ?? 0) + calc.lines[i].landedUsd)
  }

  // Quién pone la plata: el costo de la caja partido en clientes / stock propio / sin aprobar,
  // con el adelanto prorrateado por la parte del pedido que viaja acá.
  const financiamiento = financiamientoEnvio(
    envio.items.map(it => ({
      pedidoId: it.pedidoId,
      landedUsd: landedByItem.get(it.id) ?? 0,
      ventaUsd: saleByItem.get(it.id) ?? 0,
    })),
    pedidosCaja,
  )

  // Piezas sin peso o sin medidas, por línea de pedido: el aviso vive en la tabla de ítems,
  // junto a quien la pidió, que es donde se puede ir a cargarlas.
  const faltantesByItem = new Map<number, { sinPeso: number; sinMedidas: number }>()
  for (let i = 0; i < calc.lines.length; i++) {
    const l = calc.lines[i]
    if (!l.missingWeight && !l.missingDims) continue
    const itemId = allPieces[i].itemId
    const f = faltantesByItem.get(itemId) ?? { sinPeso: 0, sinMedidas: 0 }
    if (l.missingWeight) f.sinPeso++
    if (l.missingDims) f.sinMedidas++
    faltantesByItem.set(itemId, f)
  }

  // Datos serializables para la tabla (client component). Se le pasa todo resuelto para
  // que pueda pintar los cambios sin volver al servidor.
  const itemRows: EnvioItemRow[] = envio.items.map(it => ({
    id: it.id,
    pedidoId: it.pedidoId,
    clientName: it.pedido.clientName,
    nombre: cabeceraDeLinea(it).nameEs,
    bajajCode: cabeceraDeLinea(it).bajajCode,
    quantity: it.quantity,
    piezas: (it.bundleItems as BundlePiece[] | null) ?? [],
    landed: landedByItem.get(it.id) ?? 0,
    venta: saleByItem.get(it.id) ?? 0,
    shippingStatus: it.shippingStatus,
    isLanded: it.isLanded,
    shippingStatusAt: it.shippingStatusAt?.toISOString() ?? null,
    // Las líneas de un pedido propio mueven Product.stock al entregarse: la pieza suelta su
    // cantidad, el conjunto sus piezas (ver saveItemChanges y lib/stock-piezas).
    stockUnidades: it.pedido.tipo !== 'propio'
      ? 0
      : it.productId != null
        ? it.quantity
        : ((it.bundleItems as BundlePiece[] | null) ?? []).reduce((s, p) => s + p.quantity, 0) * it.quantity,
    sinPeso: faltantesByItem.get(it.id)?.sinPeso ?? 0,
    sinMedidas: faltantesByItem.get(it.id)?.sinMedidas ?? 0,
  }))

  // Lo confirmado (status='pedido') es lo que hay que comprar sí o sí; los
  // presupuestos sin aprobar todavía pueden caerse, así que se separan y nunca
  // entran al agregado masivo.
  const agruparSueltos = (pred: (p: (typeof sinAsignar)[number]) => boolean) => {
    const m = new Map<number, typeof sinAsignar>()
    for (const it of sinAsignar) {
      if (!pred(it)) continue
      const arr = m.get(it.pedidoId) ?? []
      arr.push(it)
      m.set(it.pedidoId, arr)
    }
    return Array.from(m.values())
  }
  const confirmadosSinAsignar = agruparSueltos(it => it.pedido.status === 'pedido')
  const presupuestosSinAsignar = agruparSueltos(it => it.pedido.status === 'presupuesto')
  const confirmadosPropios = confirmadosSinAsignar.filter(g => g[0].pedido.tipo === 'propio').length

  // Por presupuesto, en qué otras cajas ya viajan sus líneas y cuántas.
  const repartoPorPedido = new Map<number, Map<number, EnOtraCaja>>()
  for (const r of repartidos) {
    if (!r.envio) continue
    const cajas = repartoPorPedido.get(r.pedidoId) ?? new Map<number, EnOtraCaja>()
    const prev = cajas.get(r.envio.id)
    if (prev) prev.lineas++
    else cajas.set(r.envio.id, { envioId: r.envio.id, nombre: r.envio.nombre ?? `Envío #${r.envio.id}`, lineas: 1 })
    repartoPorPedido.set(r.pedidoId, cajas)
  }
  const lineasSueltas = (its: typeof sinAsignar): LineaSuelta[] =>
    its.map(it => ({
      id: it.id,
      // Un conjunto no tiene código ni se descontinúa (lo hacen sus piezas).
      nameEs: limpiarNombre(it.product?.nameEs ?? (it.ensamble ? nombreEnsamble(it.ensamble) : '')),
      bajajCode: it.product?.bajajCode ?? null,
      quantity: it.quantity,
      salePrice: parseFloat(it.salePrice.toString()),
      descontinuada: it.product?.discontinuedAt != null,
    }))
  const otrasCajasDe = (pedidoId: number): EnOtraCaja[] =>
    Array.from(repartoPorPedido.get(pedidoId)?.values() ?? []).sort((a, b) => a.envioId - b.envioId)

  const anyMissing = calc.lines.some(l => l.missingWeight || l.missingDims)
  const tierHint = airTierHint(calc.air.chargeableKg, calc.air.costPerKgUsd, calc.air.cajas, calc.air.capKg)
  const ratioPct = calc.air.ratioVW != null ? calc.air.ratioVW * 100 : null
  const fmtBound =
    calc.air.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  const meta = inboundMeta(inboundCaja)

  // Una fila por tramo que existe en ESTA caja. En una caja que despacha el proveedor no hay
  // flete aéreo que cargar: ese tramo es `tramoUsd` y se le paga a él dentro del giro.
  const pagosDe = (categoria: string) =>
    pagosFlete
      .filter(m => m.categoria === categoria)
      .map(m => ({
        id: m.id,
        fecha: m.fecha.toISOString(),
        monto: parseFloat(m.monto.toString()),
        metodoPago: m.metodoPago,
      }))
  const filasFlete: FilaFlete[] = []
  if (!esCbm) {
    if (inboundCaja !== 'cotizado') {
      filasFlete.push({
        tramo: 'aereo', titulo: TRAMOS_FLETE.aereo.titulo, icono: TRAMOS_FLETE.aereo.icono,
        facturadoUsd: costoRealAereo, calculadoUsd: calc.airCalculadoUsd,
        nota: 'La factura de Shoppre incluye el processing y no lleva seguro.',
        pagos: pagosDe(TRAMOS_FLETE.aereo.categoria),
        guardar: guardarFleteReal.bind(null, envio.id, 'aereo'),
        pagar: pagarFlete.bind(null, envio.id, 'aereo'),
        deshacer: deshacerPagoFlete.bind(null, envio.id),
      })
    }
    filasFlete.push({
      tramo: 'maritimo', titulo: TRAMOS_FLETE.maritimo.titulo, icono: TRAMOS_FLETE.maritimo.icono,
      facturadoUsd: costoRealMaritimo, calculadoUsd: calc.maritimeCalculadoUsd + calc.fobUsd,
      pagos: pagosDe(TRAMOS_FLETE.maritimo.categoria),
      guardar: guardarFleteReal.bind(null, envio.id, 'maritimo'),
      pagar: pagarFlete.bind(null, envio.id, 'maritimo'),
      deshacer: deshacerPagoFlete.bind(null, envio.id),
    })
  }

  // Qué parte del landed sale de datos reales y qué parte sigue siendo estimada. Una pieza con
  // costo real manda su costo; el flete es real cuando hay factura; el tramo del proveedor y las
  // comisiones, cuando se cargaron.
  const lineasConCostoReal = envio.items.filter(it => it.costRealUsd != null).length
  const realProductoUsd = allPieces.reduce(
    (acc, p, i) => acc + (p.costoRealUsd != null ? calc.lines[i].productCostUsd : 0), 0)
  const realUsd =
    realProductoUsd +
    (costoRealAereo != null ? calc.air.costUsd : 0) +
    (calc.tramo && tramoUsd != null ? calc.tramo.costUsd : 0) +
    (costoRealMaritimo != null ? calc.maritimeUsd : 0) +
    (calc.giro ? (calc.giro.salienteCargada ? calc.giro.comisionSalienteUsd : 0) + (calc.giro.entranteCargada ? calc.giro.comisionEntranteUsd : 0) : 0)
  const realPct = calc.landedUsd > 0 ? Math.min(realUsd / calc.landedUsd, 1) * 100 : 0

  // Pasos de la caja: qué falta hacer con ella. Nada se guarda, cada paso sale de datos que ya
  // existen (líneas, caja pesada, libro).
  const pagadoTramo = (cat: string) =>
    pagosFlete.filter(m => m.categoria === cat).reduce((acc, m) => acc + parseFloat(m.monto.toString()), 0)
  const compradas = envio.items.filter(it => it.shippingStatus !== 'pendiente').length
  const entregadas = envio.items.filter(it => it.shippingStatus === 'entregado').length
  // Borrador = todavía se está pensando: no cuenta como inventario en camino y no se compra,
  // paga ni avanza (ver confirmarCajaAerea). Vuelve a borrador solo si no pasó nada todavía.
  const esBorrador = envio.estado === 'borrador'
  const puedeVolverABorrador = !esBorrador && compradas === 0 && lineasConCostoReal === 0
  const pasos: { texto: string; hecho: boolean }[] = [
    { texto: 'Asignada', hecho: envio.items.length > 0 },
    { texto: 'Confirmada', hecho: !esBorrador },
    { texto: `Comprada ${compradas}/${envio.items.length}`, hecho: envio.items.length > 0 && compradas === envio.items.length },
    { texto: 'Pesada', hecho: calc.caja.medido },
  ]
  if (calc.giro && calc.giro.costoTotalUsd > 0) {
    pasos.push({ texto: 'Proveedor pagado', hecho: pagadoProveedor >= calc.giro.costoTotalUsd - 0.01 })
  }
  if (!esCbm) {
    if (inboundCaja !== 'cotizado') {
      const e = estadoFlete(costoRealAereo, pagadoTramo(TRAMOS_FLETE.aereo.categoria)).clave
      pasos.push({ texto: 'Flete aéreo pagado', hecho: e === 'pagado' || e === 'de_mas' })
    }
    const em = estadoFlete(costoRealMaritimo, pagadoTramo(TRAMOS_FLETE.maritimo.categoria)).clave
    pasos.push({ texto: 'Flete marítimo pagado', hecho: em === 'pagado' || em === 'de_mas' })
  }
  pasos.push({ texto: `Entregada ${entregadas}/${envio.items.length}`, hecho: envio.items.length > 0 && entregadas === envio.items.length })
  const proximoPaso = pasos.find(p => !p.hecho)

  return (
    <div className="max-w-screen-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/envios" className="text-gray-400 hover:text-gray-600 text-sm">Envíos</Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">#{envio.id}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{envio.nombre ?? `Envío #${envio.id}`}</h1>
            {/* Modo con el que se costeó esta caja. Se congeló al crearla, así que puede
                diferir del modo global activo — de ahí que se muestre siempre. */}
            <span
              title={MODOS.find(m => m.value === modoEnvio)?.hint}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                esCbm ? 'bg-cyan-100 text-cyan-800' : 'bg-indigo-100 text-indigo-800'
              }`}
            >
              {MODOS.find(m => m.value === modoEnvio)?.icon}{' '}
              {MODOS.find(m => m.value === modoEnvio)?.label}
            </span>
          </div>
          {envio.notas && <p className="text-sm text-gray-500 mt-1">{envio.notas}</p>}
          {esBorrador && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
              <p className="text-sm text-amber-900">
                <span className="font-semibold">Borrador.</span>{' '}
                Todavía no es una compra: no cuenta como inventario en camino, y no se compra, paga ni avanza.
              </p>
              {items.length > 0 && (
                <FormConResultado action={confirmarCajaAerea.bind(null, envio.id)} className="flex flex-wrap items-center gap-2">
                  <PendingButton className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50">
                    Confirmar compra
                  </PendingButton>
                </FormConResultado>
              )}
            </div>
          )}
          {puedeVolverABorrador && (
            <FormConResultado action={volverCajaABorrador.bind(null, envio.id)} className="mt-2 flex flex-wrap items-center gap-2">
              <PendingButton className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50">
                Volver a borrador
              </PendingButton>
            </FormConResultado>
          )}
          {/* Qué le falta a la caja, derivado de lo que ya hay cargado. */}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {pasos.map(p => (
                <span
                  key={p.texto}
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    p.hecho
                      ? 'bg-green-100 text-green-700'
                      : p === proximoPaso
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {p.hecho ? '✓' : p === proximoPaso ? '●' : '○'} {p.texto}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* El flete ya no se "guarda": la lista de envíos lo calcula en vivo con el mismo
              costeo que esta ficha (lib/costo-envios). Una copia guardada quedaba vieja en
              cuanto se cargaba un peso, un precio real o se movía una tasa. */}
          <DeleteButton
            action={deleteEnvio.bind(null, envio.id)}
            confirmMessage={`¿Eliminar el envío "${envio.nombre ?? `#${envio.id}`}"? Los ítems quedarán libres.`}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 mb-8">
          <p className="text-lg">Este envío está vacío</p>
          <p className="text-sm mt-1">Agregá ítems abajo para calcular el peso cobrable y el costo.</p>
        </div>
      ) : (
        <>
          {/* Arriba, lado a lado, lo que se LEE y no cambia de alto: el tramo y el costo. Todo lo
              que se edita va debajo a todo el ancho, para que al crecer una tarjeta (la
              comparación de la caja, un aviso) no reacomode a la vecina. */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4 items-stretch">
          {esCbm ? (
          /* Modo CBM: no hay tramos a USA. Lo único que gobierna el costo es cuánto
             volumen lleva la caja contra el mínimo que la naviera factura igual. */
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                🚢 Embarque marítimo · llenado
              </h2>
              {calc.minM3Applied && (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
                  Pagando el mínimo
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-400 mb-1">Volumen real</p>
                <p className="text-xl font-bold font-mono text-gray-900">{m3(calc.volumeM3)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Facturable</p>
                <p className={`text-xl font-bold font-mono ${calc.minM3Applied ? 'text-amber-700' : 'text-gray-900'}`}>
                  {m3(calc.billableM3)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Tarifa</p>
                <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.cbmRatePerM3)}<span className="text-xs text-gray-400">/m³</span></p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Costo real / m³</p>
                <p className="text-xl font-bold font-mono text-blue-700">
                  {calc.volumeM3 > 0 ? usd((calc.maritimeUsd + calc.fobUsd) / calc.volumeM3) : '—'}
                </p>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-500">Llenado del volumen facturable</span>
                <span className="font-mono font-semibold text-gray-700">{(calc.cbmFillPct * 100).toFixed(0)}%</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    calc.cbmFillPct >= 0.9 ? 'bg-green-500' : calc.cbmFillPct >= 0.6 ? 'bg-amber-400' : 'bg-red-500'
                  }`}
                  style={{ width: `${Math.min(calc.cbmFillPct * 100, 100)}%` }}
                />
              </div>
              <p className="text-xs mt-2 text-gray-600">
                {calc.minM3Applied
                  ? `⚠️ Vas a pagar ${m3(calc.billableM3)} mandando ${m3(calc.volumeM3)}: te sobran ${m3(calc.billableM3 - calc.volumeM3)} ya pagados. Meté más piezas antes de cerrar — viajan sin costo de flete adicional.`
                  : calc.cbmFillPct >= 0.9
                    ? '✓ La caja va llena: estás pagando volumen que efectivamente usás.'
                    : 'Estás por encima del mínimo, así que cada m³ extra se cobra — pero el FOB fijo se sigue diluyendo entre más piezas.'}
              </p>
            </div>

            {calc.fobUsd > 0 && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-blue-50 text-blue-700">
                El FOB de India ({usd(calc.fobUsd)}) es fijo por embarque: hoy pesa{' '}
                <span className="font-mono font-semibold">
                  {calc.volumeM3 > 0 ? `${usd(calc.fobUsd / calc.volumeM3)}/m³` : '—'}
                </span>
                . Cuanto más llenes, menos le toca a cada pieza.
              </p>
            )}

            {calc.cbmRatePerM3 === 0 && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                ⚠️ No hay tarifa por m³ cargada: el flete está contando 0 y el envío queda subcosteado.{' '}
                <Link href="/config" className="font-mono underline">cbm_rate_usd</Link> en Configuración.
              </p>
            )}

            {anyMissing && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                ⚠️ Hay piezas sin dimensiones cargadas — no suman volumen y el llenado real es mayor al que ves.
              </p>
            )}
          </div>
          ) : (
          /* Tramo India → USA (ShipGlobal): el único que cotiza por tabla escalón */
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 h-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                {calc.air.items === 0 && calc.tramo
                  ? `✈️ Tramo ${calc.tramo.nombre} → USA · DDP`
                  : '🇮🇳 Tramo India → USA · peso cobrable'}
              </h2>
              {calc.air.items > 0 && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
              )}
            </div>
            {calc.air.items === 0 && calc.tramo ? (
              /* Caja que despacha el proveedor: no hay tabla escalón ni peso cobrable, el
                 tramo es el total que él facturó. */
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Piezas</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{calc.tramo.leg.items}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Peso real</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{kg(calc.tramo.leg.realKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Volumétrico</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{kg(calc.tramo.leg.volKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Facturado / kg</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.tramo.leg.costPerKgUsd)}</p>
                  </div>
                </div>
                <p className="text-xs mt-4 px-3 py-2 rounded-lg bg-blue-50 text-blue-700">
                  Despacha {calc.tramo.nombre} a USA: no hay tarifa por kilo, el tramo es el total que
                  facturó ({usd(calc.tramo.costUsd)}). Se carga en la tarjeta del proveedor, más abajo.
                </p>
              </>
            ) : calc.air.items === 0 ? (
              <p className="text-sm text-gray-400">No hay piezas que viajen por Shoppre en este envío.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Peso real (ΣW)</p>
                    <p className={`text-xl font-bold font-mono ${calc.air.binding === 'weight' ? 'text-green-700' : 'text-gray-900'}`}>{kg(calc.air.realKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Volumétrico (ΣV)</p>
                    <p className={`text-xl font-bold font-mono ${calc.air.binding === 'volume' ? 'text-red-700' : 'text-gray-900'}`}>{kg(calc.air.volKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
                    <p className="text-xl font-bold font-mono text-blue-700">{kg(calc.air.chargeableKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Aéreo / kg</p>
                    <p className="text-xl font-bold font-mono text-gray-900">{usd(calc.air.costPerKgUsd)}</p>
                  </div>
                </div>

                {/* Utilización volumétrica */}
                {ratioPct != null && (
                  <div className="mt-5">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-gray-500">Utilización volumétrica (V/W) — meta 80–100%</span>
                      <span className="font-mono font-semibold text-gray-700">{ratioPct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden relative">
                      {/* zona dulce 80-100% */}
                      <div className="absolute inset-y-0 bg-green-100" style={{ left: '80%', right: '0%' }} />
                      <div
                        className={`h-full rounded-full ${calc.air.binding === 'volume' ? 'bg-red-500' : ratioPct >= 80 ? 'bg-green-500' : 'bg-amber-400'}`}
                        style={{ width: `${Math.min(ratioPct, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs mt-2 text-gray-600">
                      {calc.air.binding === 'volume'
                        ? '⚠️ Volume-bound: el carrier cobra el volumétrico (> peso). Agregá piezas pesadas para volver a estar atado por peso, o tus precios fijos subcostean.'
                        : ratioPct >= 80
                          ? '✓ Buena utilización: estás llenando el volumen que ya pagás por peso.'
                          : 'Desperdiciás volumen pagado. Podés colar piezas voluminosas y ligeras (plásticos) casi gratis hasta llegar al 100%.'}
                    </p>
                  </div>
                )}

                {tierHint && (
                  <p className={`text-xs mt-3 px-3 py-2 rounded-lg ${tierHint.tone === 'good' ? 'bg-green-50 text-green-700' : tierHint.tone === 'warn' ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-700'}`}>
                    {tierHint.text}
                  </p>
                )}
              </>
            )}

            {anyMissing && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                ⚠️ Algunas piezas no tienen peso o dimensiones cargadas — el cálculo las subestima. Revisá las marcadas en la tabla de ítems.
              </p>
            )}
          </div>

          )}

          {/* Desglose de costo. Cada fila dice si el número es REAL (factura, costo pagado) o
              ESTIMADO (tabla, catálogo): sin eso, cargar un dato no se nota. */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 h-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Costo del envío (landed)</h2>
              <span
                title="Porción del costo total que sale de datos reales (costo pagado de las piezas, facturas, tramo y comisiones cargados)"
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  realPct >= 99.5 ? 'bg-green-100 text-green-700' : realPct >= 50 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                }`}
              >
                Real al {realPct.toFixed(0)}%
              </span>
            </div>
            <dl className="space-y-2 text-sm">
              <Row
                label="Costo de producto"
                value={usd(calc.productCostUsd)}
                tag={
                  lineasConCostoReal === 0
                    ? { texto: 'estimado', tono: 'est' }
                    : lineasConCostoReal === envio.items.length
                      ? { texto: 'real', tono: 'real' }
                      : { texto: `${lineasConCostoReal} de ${envio.items.length} líneas reales`, tono: 'est' }
                }
              />
              {esCbm ? (
                <>
                  <Row
                    label={`Marítimo India→VEN · ${m3(calc.billableM3)} × ${usd(calc.cbmRatePerM3)}/m³`}
                    value={usd(calc.maritimeUsd)}
                  />
                  <Row label="FOB India (fijo por embarque)" value={usd(calc.fobUsd)} />
                </>
              ) : (
                <>
                  {calc.air.items > 0 && (
                    <Row
                      label={`Aéreo Shoppre→USA · ${calc.air.chargeableKg.toFixed(1)} kg cobrables${calc.air.cajas > 1 ? ` en ${calc.air.cajas} cajas (${calc.air.cajasKg.map(k => `${k} kg`).join(' + ')})` : ''}`}
                      value={usd(calc.air.costUsd)}
                      tag={costoRealAereo != null
                        ? { texto: 'facturado', tono: 'real' }
                        : { texto: calc.caja.medido ? 'estimado s/ caja real' : 'estimado', tono: 'est' }}
                    />
                  )}
                  {calc.tramo && (
                    <Row
                      label={`Envío ${calc.tramo.nombre}→USA (DDP, total)`}
                      value={usd(calc.tramo.costUsd)}
                      tag={tramoUsd != null ? { texto: 'facturado', tono: 'real' } : { texto: 'sin cargar', tono: 'falta' }}
                    />
                  )}
                  <Row
                    label="Marítimo USA→VEN (volumen)"
                    value={usd(calc.maritimeUsd)}
                    tag={costoRealMaritimo != null
                      ? { texto: 'facturado', tono: 'real' }
                      : { texto: 'estimado por ft³', tono: 'est' }}
                  />
                  {/* Seguro y processing son cargos de Shoppre: solo los paga lo que pasa por su
                      depósito, y solo se muestran si valen algo (la factura ya trae el processing
                      y Shoppre no cobra seguro: una fila en $0.00 es un cargo que no existe). */}
                  {calc.insuranceUsd > 0 && <Row label="Seguro Shoppre" value={usd(calc.insuranceUsd)} />}
                  {calc.processingUsd > 0 && (
                    <Row label="Processing Shoppre" value={usd(calc.processingUsd)} tag={{ texto: 'estimado', tono: 'est' }} />
                  )}
                  {calc.giro && (
                    <>
                      <Row
                        label={`Comisión saliente · ${calc.giro.nombre}`}
                        value={calc.giro.salienteCargada ? usd(calc.giro.comisionSalienteUsd) : '—'}
                        tag={calc.giro.salienteCargada ? { texto: 'real', tono: 'real' } : { texto: 'sin cargar', tono: 'falta' }}
                      />
                      <Row
                        label={`Comisión entrante · ${calc.giro.nombre}`}
                        value={calc.giro.entranteCargada ? usd(calc.giro.comisionEntranteUsd) : '—'}
                        tag={calc.giro.entranteCargada ? { texto: 'real', tono: 'real' } : { texto: 'sin cargar', tono: 'falta' }}
                      />
                    </>
                  )}
                </>
              )}
              {calc.landedDirectUsd > 0 && (
                <Row label="Compras puestas en Venezuela (no viajan)" value={usd(calc.landedDirectUsd)} />
              )}
              <div className="flex justify-between pt-3 mt-2 border-t-2 border-gray-200">
                <dt className="font-bold text-gray-900">Costo total landed</dt>
                <dd className="font-bold text-xl font-mono text-blue-700">{usd(calc.landedUsd)}</dd>
              </div>
              {/* El landed incluye TODO lo que viaja, stock propio también, así que la venta y el
                  margen se miden contra ese mismo total. La venta del stock propio es la estimada
                  del catálogo (todavía no es plata cobrada) y se rotula como tal. */}
              {financiamiento.ventaTotalUsd > 0 && (
                <>
                  <Row label="Venta a clientes" value={usd(financiamiento.clientes.ventaUsd)} />
                  {financiamiento.propio.ventaEstimadaUsd > 0 && (
                    <Row
                      label="Venta estimada de stock propio"
                      value={usd(financiamiento.propio.ventaEstimadaUsd)}
                      tag={{ texto: 'estimado', tono: 'est' }}
                    />
                  )}
                  {financiamiento.sinAprobar.ventaUsd > 0 && (
                    <Row label="Presupuestos sin aprobar" value={usd(financiamiento.sinAprobar.ventaUsd)} tag={{ texto: 'estimado', tono: 'est' }} />
                  )}
                  <div className="flex justify-between">
                    <dt className="font-semibold text-gray-700">Margen bruto (total)</dt>
                    <dd className={`font-semibold font-mono ${financiamiento.margenTotalUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {usd(financiamiento.margenTotalUsd)}
                      {' '}
                      <span className="text-xs text-gray-400">
                        ({((financiamiento.margenTotalUsd / financiamiento.ventaTotalUsd) * 100).toFixed(0)}%)
                      </span>
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </div>
          </div>

          {/* La caja real. Es el único dato del envío que no se puede derivar del
              catálogo: el catálogo tiene la pieza desnuda, la balanza pesa el bulto. */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                📦 Caja real · peso y medidas
              </h2>
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  calc.caja.medido ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {calc.caja.medido ? 'MEDIDA' : 'SIN MEDIR'}
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Copiá lo que dice el panel del transportista: <em>Actual Weight</em> y{' '}
              <em>Box Dimensions</em>. Estos números <strong>reemplazan</strong> a la suma
              de las piezas — es lo que se factura.
            </p>

            <FormConResultado action={saveMedidasCaja.bind(null, envio.id)}>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Peso real (kg)</label>
                  <input
                    type="number" step="0.01" min="0" name="pesoRealKg"
                    defaultValue={medidas.pesoKg ?? ''}
                    placeholder={calc.netRealKg > 0 ? calc.netRealKg.toFixed(2) : '0.00'}
                    className="w-28 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Caja L × A × H (cm)</label>
                  <div className="flex items-center gap-1">
                    {(['cajaL', 'cajaA', 'cajaH'] as const).map((f, i) => (
                      <div key={f} className="flex items-center gap-1">
                        {i > 0 && <span className="text-gray-300 text-sm">×</span>}
                        <input
                          type="number" step="0.1" min="0" name={f}
                          defaultValue={envio[f] ?? ''}
                          placeholder="0"
                          className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <PendingButton
                  className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Guardar
                </PendingButton>
              </div>
            </FormConResultado>

            {calc.caja.medido && (
              <div className="mt-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 uppercase tracking-wide">
                      <th className="text-left font-medium pb-1"></th>
                      <th className="text-right font-medium pb-1">Suma de piezas</th>
                      <th className="text-right font-medium pb-1">Caja real</th>
                      <th className="text-right font-medium pb-1">Falta en el catálogo</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    <tr className="border-t border-gray-100">
                      <td className="py-2 font-sans text-gray-600">Peso</td>
                      <td className="py-2 text-right text-gray-400">{kg(calc.netRealKg)}</td>
                      <td className="py-2 text-right text-gray-900 font-semibold">{kg(calc.realKg)}</td>
                      <td className="py-2 text-right text-amber-700">{kg(calc.realKg - calc.netRealKg)}</td>
                    </tr>
                    <tr className="border-t border-gray-100">
                      <td className="py-2 font-sans text-gray-600">Volumen</td>
                      <td className="py-2 text-right text-gray-400">{m3(calc.netVolumeM3)}</td>
                      <td className="py-2 text-right text-gray-900 font-semibold">{m3(calc.volumeM3)}</td>
                      <td className="py-2 text-right text-amber-700">{m3(calc.volumeM3 - calc.netVolumeM3)}</td>
                    </tr>
                    {!esCbm && (
                      <tr className="border-t border-gray-100">
                        <td className="py-2 font-sans text-gray-600">Cobrable max(W,V)</td>
                        <td className="py-2 text-right text-gray-400">{kg(calcNeto!.air.chargeableKg)}</td>
                        <td className="py-2 text-right text-blue-700 font-semibold">{kg(calc.air.chargeableKg)}</td>
                        <td className="py-2 text-right text-gray-300">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>

              </div>
            )}
          </div>

          {/* Lo que cobraron los transportistas y si ya se les pagó. Aparte de la caja real: son
              datos que llegan en momentos distintos y se pagan a empresas distintas. */}
          <FleteRealCard methods={METODOS_PAGO_EGRESO} filas={filasFlete} />

          {/* Costo real de las piezas de ESTA caja: corregir peso/dimensión (abajo) no dice
              cuánto costó lo de adentro. Mismo picker que /contabilidad/comprar, acotado a
              este envío — colapsado por default, y adentro cada cliente también (el precio por pieza o por
              cliente es opcional: casi siempre se paga todo junto). Va junto a los fletes: son los
              tres lugares donde se carga lo que de verdad se pagó. */}
          {!esBorrador && itemsPendientesCosto.length > 0 && (
            <RegistrarCompraPicker
              items={itemsPendientesCosto}
              action={registrarCompra}
              methods={METODOS_PAGO_EGRESO}
              collapsible
            />
          )}

          {/* Lo que se le paga al proveedor de la caja. Junta los dos montos que nadie
              puede derivar: lo que facturó por traerla a USA (solo si despacha él) y lo
              que costó la transferencia con la que se le giró. */}
          {calc.giro && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                  💸 {calc.giro.nombre} · lo que le pagás
                </h2>
                <span
                  title={meta.hint}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                    inboundCaja === 'cotizado' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {meta.icon} {meta.label}
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                Le girás <span className="font-mono font-semibold text-gray-600">{usd(calc.giro.montoUsd)}</span>
                {' '}({usd(calc.giro.mercanciaUsd)} de mercancía
                {calc.giro.tramoUsd > 0 && ` + ${usd(calc.giro.tramoUsd)} de envío`}).
                {inboundCaja === 'cotizado'
                  ? ' Despacha él a USA, así que no hay tarifa por kilo: se carga el total que te pasó.'
                  : ' Entra por Shoppre, así que el tramo lo cobra la tabla escalón.'}
              </p>

              <FormConResultado action={saveCostosProveedor.bind(null, envio.id)} className="flex flex-wrap items-end gap-3">
                {/* El total del envío solo se pide a quien despacha por su cuenta: para una
                    caja que entra por Shoppre ese número lo pone la tabla escalón, y un
                    campo vacío al lado invitaría a cargarlo dos veces. */}
                {inboundCaja === 'cotizado' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Envío + impuestos (USD)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      name="tramoUsd"
                      defaultValue={tramoUsd ?? ''}
                      placeholder="0.00"
                      className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">el total que te pasó, DDP</p>
                  </div>
                )}
                {/* Las dos puntas del giro. Van separadas porque se saben en momentos
                    distintos: la saliente el mismo día, la entrante cuando el proveedor
                    avisa que le llegó de menos. Con un solo campo había que inventar una
                    para poder anotar la otra. */}
                <div>
                  <label
                    className="block text-xs font-medium text-gray-600 mb-1"
                    title="Lo que MI banco cobró por emitir el giro. Vacío = todavía no lo sé; 0 = no cobró nada"
                  >
                    Comisión saliente (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="comisionSalienteUsd"
                    defaultValue={comisionSalienteUsd ?? ''}
                    placeholder="sin cargar"
                    className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    lo que te cobró tu banco por girar {usd(calc.giro.montoUsd)}
                  </p>
                </div>
                <div>
                  <label
                    className="block text-xs font-medium text-gray-600 mb-1"
                    title="Lo que le descontaron a ÉL al acreditar y tuviste que completarle. Vacío = todavía no lo sé; 0 = le llegó completo"
                  >
                    Comisión entrante (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="comisionEntranteUsd"
                    defaultValue={comisionEntranteUsd ?? ''}
                    placeholder="sin cargar"
                    className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    lo que le descontaron al recibir y le completaste
                  </p>
                </div>
                <PendingButton
                  className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Guardar
                </PendingButton>
              </FormConResultado>

              {calc.tramo?.faltaCosto && (
                <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mt-3">
                  ⚠️ Sin el total del envío, las piezas viajan gratis en el cálculo y toda la
                  caja queda subcosteada.
                </p>
              )}
              {!calc.giro.cargada && (
                <p className="text-xs text-gray-500 bg-gray-50 px-3 py-2 rounded-lg mt-2">
                  {!calc.giro.salienteCargada && !calc.giro.entranteCargada
                    ? 'Las dos comisiones están '
                    : !calc.giro.salienteCargada
                      ? 'La comisión saliente está '
                      : 'La comisión entrante está '}
                  <strong>sin cargar</strong>, así que hoy cuenta{calc.giro.salienteCargada || calc.giro.entranteCargada ? '' : 'n'} como
                  $0 y el landed sale corto. Si esa punta no cobró nada, poné 0 y queda dicho.
                </p>
              )}
              {calc.giro.cargada && calc.giro.comisionUsd > 0 && (
                <p className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg mt-2">
                  El giro te costó <span className="font-mono font-semibold">{usd(calc.giro.costoTotalUsd)}</span> en
                  total: {usd(calc.giro.montoUsd)} facturados + {usd(calc.giro.comisionSalienteUsd)} de saliente
                  + {usd(calc.giro.comisionEntranteUsd)} de entrante.
                </p>
              )}

              {/* Plata que ya salió de la cuenta contra esta caja (libro de movimientos),
                  no lo facturado — son dos números distintos a propósito. */}
              <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-100">
                <p className="text-xs text-gray-500">
                  Pagado: <span className="font-mono font-semibold text-gray-700">{usd(pagadoProveedor)}</span>
                  {' de '}
                  <span className="font-mono">{usd(calc.giro.costoTotalUsd)}</span>
                  {calc.giro.costoTotalUsd - pagadoProveedor > 0.01 && (
                    <> — faltan <span className="font-mono font-semibold text-amber-700">{usd(calc.giro.costoTotalUsd - pagadoProveedor)}</span></>
                  )}
                </p>
                {!esBorrador && <RegistrarPagoProveedorForm action={registrarPagoProveedor.bind(null, envio.id)} methods={METODOS_PAGO_EGRESO} />}
              </div>
            </div>
          )}
          {/* La plata va primero: antes de mirar cuánto cuesta la caja, la pregunta es
              cuánta de esa plata ya está en la mano. */}
          <QuienPonePlata f={financiamiento} />

          {/* Ítems del envío: los cambios se pintan al instante y se guardan por detrás
              (la base es remota, esperar cada round-trip mata el uso). */}
          <EnvioItemsTable
            envioId={envio.id}
            items={itemRows}
            inbound={inboundCaja}
            guardar={saveItemChanges}
            quitar={removePedido}
            bloqueada={esBorrador}
          />

          {/* Lo pendiente de comprar, listo para copiar o bajar en CSV */}
          <PendientesCompraButton
            envio={envio.nombre ?? `Envío #${envio.id}`}
            grupos={pendientes}
            inrUsd={inrUsd}
            compra99={compra99}
          />

          {/* Contenido de la caja por SKU, separado por origen: son dos órdenes distintas. Es la
              caja ENTERA (incluye lo ya comprado); lo que falta comprar está en el botón de
              pendientes. Plegado, con el total en el título para no tener que abrirlo. */}
          {buyIndia.length > 0 && (
            <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
              <summary className="px-6 py-3 bg-gray-50 cursor-pointer text-sm font-semibold text-gray-500 uppercase tracking-wide">
                🇮🇳 Contenido de la caja por SKU · {buyIndia.length} {buyIndia.length === 1 ? 'ítem' : 'ítems'} · {buyUnits} u.
                {' · '}
                {buyTotalInr > 0 && <>{Math.round(buyTotalInr).toLocaleString('es-VE')} INR ≈ </>}
                {usd(buyTotalUsd)}
              </summary>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-6 py-2 font-semibold">Código</th>
                    <th className="text-left px-3 py-2 font-semibold">Pieza</th>
                    <th className="text-right px-3 py-2 font-semibold">Cant.</th>
                    <th className="text-right px-3 py-2 font-semibold">Unitario</th>
                    <th className="text-right px-6 py-2 font-semibold">Total USD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {buyIndia.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-2.5 font-mono text-xs text-gray-500">{r.sku ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-900">
                        {r.name}
                        {r.missingPrice && (
                          <span className="ml-2 text-xs text-amber-600">sin precio</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">
                        {r.unit != null
                          ? r.moneda === 'USD' ? usd(r.unit) : `${r.unit.toLocaleString('es-VE')} INR`
                          : '—'}
                      </td>
                      <td className="px-6 py-2.5 text-right font-mono font-semibold text-gray-900">
                        {r.totalUsd > 0 ? usd(r.totalUsd) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50">
                    <td className="px-6 py-3 font-bold text-gray-900" colSpan={2}>Total de la caja</td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-gray-700">{buyUnits}</td>
                    <td className="px-3 py-3"></td>
                    <td className="px-6 py-3 text-right">
                      <span className="font-bold font-mono text-blue-700">{usd(buyTotalUsd)}</span>
                      {buyTotalInr > 0 && (
                        <span className="block text-xs text-gray-400 font-mono">
                          {Math.round(buyTotalInr).toLocaleString('es-VE')} INR a {inrUsd}
                        </span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </details>
          )}

          {buyChina.length > 0 && (
            <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
              <summary className="px-6 py-3 bg-gray-50 cursor-pointer text-sm font-semibold text-gray-500 uppercase tracking-wide">
                🇨🇳 Contenido de la caja por SKU · {buyChina.length} {buyChina.length === 1 ? 'ítem' : 'ítems'}
              </summary>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-6 py-2 font-semibold">Código</th>
                    <th className="text-left px-3 py-2 font-semibold">Pieza</th>
                    <th className="text-right px-6 py-2 font-semibold">Cant.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {buyChina.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-2.5 font-mono text-xs text-gray-500">{r.sku ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-900">{r.name}</td>
                      <td className="px-6 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}

      {/* Pedidos confirmados con ítems sin asignar */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Pedidos confirmados con ítems sueltos ({confirmadosSinAsignar.length})
          </h2>
          {confirmadosSinAsignar.length > 0 && (
            <FormConResultado
              action={assignAllConfirmados.bind(null, envio.id)}
              className="flex items-center gap-3 flex-wrap"
            >
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" name="incluirPropio" defaultChecked className="rounded border-gray-300" />
                Incluir stock propio ({confirmadosPropios})
              </label>
              <PendingButton
                pendingLabel="Agregando…"
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors"
              >
                + Agregar todos los confirmados
              </PendingButton>
            </FormConResultado>
          )}
        </div>
        {confirmadosSinAsignar.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">
            No hay pedidos confirmados con ítems sin asignar.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {confirmadosSinAsignar.map(its => (
              <SueltoPedido
                key={its[0].pedidoId}
                envioId={envio.id}
                pedidoId={its[0].pedidoId}
                clientName={its[0].pedido.clientName}
                tipo={its[0].pedido.tipo}
                lineas={lineasSueltas(its)}
                otrasCajas={otrasCajasDe(its[0].pedidoId)}
                agregarTodo={assignPedido}
                agregarElegidas={assignItems}
              />
            ))}
          </div>
        )}
      </div>

      {/* Presupuestos sin aprobar (informativo, no entran al agregado masivo) */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Presupuestos sin aprobar ({presupuestosSinAsignar.length})
          </h2>
        </div>
        {presupuestosSinAsignar.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-400">
            No hay presupuestos pendientes. <Link href="/presupuestos/new" className="text-blue-600 hover:underline">Creá uno</Link>.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {presupuestosSinAsignar.map(its => (
              <SueltoPedido
                key={its[0].pedidoId}
                envioId={envio.id}
                pedidoId={its[0].pedidoId}
                clientName={its[0].pedido.clientName}
                tipo={its[0].pedido.tipo}
                lineas={lineasSueltas(its)}
                otrasCajas={otrasCajasDe(its[0].pedidoId)}
                sinAprobar
                agregarTodo={assignPedido}
                agregarElegidas={assignItems}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Parte({ label, valor, tono }: { label: string; valor: number; tono: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono font-semibold ${tono}`}>{usd(valor)}</span>
    </span>
  )
}

// Quién pone la plata en la caja. La pregunta es de caja chica: para comprar esto hay que poner
// {costo}; una parte es de clientes que ya adelantaron (o deben), otra es inventario tuyo y otra
// un presupuesto que todavía no es venta. Separarlas dice cuánto es financiar y cuánto es invertir.
function QuienPonePlata({ f }: { f: FinanciamientoEnvio }) {
  if (f.costoUsd <= 0) return null
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 mb-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">💵 Quién pone la plata</h2>
      <p className="text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-gray-500">Costo de la caja</span>
        <span className="font-mono font-bold text-gray-900">{usd(f.costoUsd)}</span>
        <span className="text-gray-300">=</span>
        <Parte label="Clientes" valor={f.clientes.costoUsd} tono="text-gray-900" />
        {f.propio.costoUsd > 0 && <><span className="text-gray-300">+</span><Parte label="Stock propio" valor={f.propio.costoUsd} tono="text-sky-700" /></>}
        {f.sinAprobar.costoUsd > 0 && <><span className="text-gray-300">+</span><Parte label="Sin aprobar" valor={f.sinAprobar.costoUsd} tono="text-amber-700" /></>}
      </p>
      <p className="text-sm mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-gray-500">Adelantos que la cubren</span>
        <span className="font-mono font-semibold text-green-700">{usd(f.adelantosUsd)}</span>
        {f.pedidosPartidos > 0 && (
          <span className="text-xs text-gray-400">
            ({f.pedidosPartidos === 1 ? 'un pedido está partido' : `${f.pedidosPartidos} pedidos están partidos`} entre cajas: el adelanto cuenta en proporción)
          </span>
        )}
      </p>
      <p className="text-sm mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-gray-500">De tu bolsillo hasta entregar</span>
        <span className="font-mono font-bold text-lg text-amber-700">{usd(f.bolsilloUsd)}</span>
        <span className="text-gray-300">=</span>
        <Parte label="clientes por cobrar" valor={f.clientes.porCobrarUsd} tono="text-gray-900" />
        {f.propio.costoUsd > 0 && <><span className="text-gray-300">+</span><Parte label="inventario tuyo" valor={f.propio.costoUsd} tono="text-sky-700" /></>}
        {f.sinAprobar.costoUsd > 0 && <><span className="text-gray-300">+</span><Parte label="riesgo" valor={f.sinAprobar.costoUsd} tono="text-amber-700" /></>}
      </p>
      {f.clientes.pedidos > 0 && (
        <p className="text-xs mt-2">
          <Link href="/clientes" className="text-blue-600 hover:underline">
            Ver saldos de {f.clientes.pedidos === 1 ? 'este cliente' : `estos ${f.clientes.pedidos} clientes`} →
          </Link>
        </p>
      )}
    </div>
  )
}

const TAG_CLS = {
  real: 'bg-green-100 text-green-700',
  est: 'bg-gray-100 text-gray-500',
  falta: 'bg-amber-100 text-amber-700',
} as const

function Row({ label, value, tag }: { label: string; value: string; tag?: { texto: string; tono: keyof typeof TAG_CLS } }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono text-gray-800 flex items-baseline gap-2 shrink-0">
        {tag && (
          <span className={`font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TAG_CLS[tag.tono]}`}>
            {tag.texto}
          </span>
        )}
        {value}
      </dd>
    </div>
  )
}
