import { db } from '@/lib/db'
import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
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
import RegistrarCompraPicker, { type PagoCaja } from '@/components/RegistrarCompraPicker'
import { SinStockCaja, BuscarSinStock, type SinStockFila, type PiezaComprada } from '@/components/CompraEsperas'
import { METODOS_PAGO_EGRESO } from '@/lib/pagos'
import { limpiarNombre } from '@/lib/utils'
import { calcEnvio, LB_POR_KG, type EnvioItemInput, type ConfigMap, type ProveedorEnvio } from '@/lib/calc'
import { inboundDe, inboundMeta } from '@/lib/inbound'
import { reenvioDe, reenvioMeta, tarifaEquilibrioKgInr, motivoReenvioNoCoincide, tablaPorKilo } from '@/lib/reenvio'
import { modoDeEnvio, MODOS } from '@/lib/modo'
import { motivoExpressNoAprobable, topeDeCaja } from '@/lib/express'
import { contextoCosteo, costearAereo, ENVIO_COSTEO_INCLUDE } from '@/lib/costo-envios'
import { motivoNoMueve, motivoNoMueveSinEnviar, type CajaParaMover } from '@/lib/mover-caja'
import EnvioMaritimo from './maritimo'
import { lookupDeConjuntos, expandCostPieces, repartirCostoReal } from '@/lib/envio-build'
import { financiamientoEnvio, type FinanciamientoEnvio } from '@/lib/financiamiento-envio'
import FleteRealCard, { type FilaFlete } from '@/components/FleteRealCard'
import NumerosTramo, { type NumeroGuardado } from '@/components/NumerosTramo'
import CajasEnvio from '@/components/CajasEnvio'
import { CAJA_SELECT, cajaFisica, cajasQueSeFacturan, medidasDeCajas } from '@/lib/cajas-envio'
import { apiKeyShip24, ENV_API_KEY, eventosGuardados, horaConsulta } from '@/lib/ship24'
import { credencialesOneway } from '@/lib/oneway'
import { listaCouriers } from '@/lib/sync-trackings'
import { esTramoTracking } from '@/lib/tracking'
import ConteoCaja, { BotonConteo } from '@/components/ConteoCaja'
import PestanasCaja from '@/components/PestanasCaja'
import TrayectoCaja from '@/components/TrayectoCaja'
import SeccionCaja from '@/components/SeccionCaja'
import { piezasAContar } from '@/lib/conteo'
import { etiquetaPieza, lineaNoViene, perdidaSugerida, sinEnviarDe, textoSinEnviar, tiposPara } from '@/lib/incidencias'
import { statusIndex } from '@/lib/shipping-status'
import { seEntregaDesdeElPedido } from '@/lib/saldo-entrega'
import { TRAMOS_FLETE, CATEGORIAS_FLETE, estadoFlete } from '@/lib/flete-real'
import { itemsSinCostoRealDeEnvio, CATEGORIAS_PAGO_PROVEEDOR, CATEGORIAS_REEMBOLSO_PROVEEDOR } from '@/lib/movimientos'
import type { BundlePiece } from '@/lib/bundle'
import { num, toConfigMap } from '@/lib/config'
import { armarCompra99rpm } from '@/lib/compra-99rpm'
import { cabeceraDeLinea, nombreEnsamble } from '@/lib/linea-pedido'
import { registrarCompra } from '@/app/(pages)/contabilidad/actions'
import {
  assignPedido,
  assignItems,
  assignAllConfirmados,
  removePedido,
  marcarSinStock,
  resolverSinStock,
  sacarSinStock,
  moverSinStockACaja,
  separarSinStock,
  deleteEnvio,
  saveCostosProveedor,
  guardarCotizacionDeposito,
  guardarCajas,
  guardarTrackings,
  actualizarTrackings,
  guardarFleteReal,
  pagarFlete,
  deshacerPagoFlete,
  saveItemChanges,
  registrarPagoProveedor,
  confirmarCajaAerea,
  volverCajaABorrador,
  moverPedidoACaja,
} from '../actions'

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`
// Como en el libro: "5 nov", en hora de Venezuela.
const fechaCorta = (d: Date) => d.toLocaleDateString('es-VE', { day: 'numeric', month: 'short', timeZone: 'America/Caracas' })
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

export const metadata = { title: 'Caja' }

export default async function EnvioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  // Los dos carriles son documentos distintos, no variantes del mismo: el marítimo lleva
  // mercancía propia (EnvioLinea) y se arma pieza por pieza, el aéreo agrupa pedidos de
  // cliente. Se bifurca acá arriba en vez de llenar la ficha de condicionales.
  const ruta = await db.envio.findUnique({ where: { id }, select: { modo: true, compraDeId: true } })
  if (!ruta) notFound()
  if (ruta.modo === 'maritimo_cbm') return <EnvioMaritimo envioId={id} />
  // Las cajas de la misma compra (una caja partida en el depósito, ver lib/mover-caja.ts): lo
  // debido y lo pagado al proveedor se leen juntos, porque el giro fue uno.
  const raizCompra = ruta.compraDeId ?? id
  const familia = await db.envio.findMany({
    where: { OR: [{ id: raizCompra }, { compraDeId: raizCompra }] },
    select: { id: true, nombre: true },
    orderBy: { id: 'asc' },
  })
  const idsCompra = familia.map(f => f.id)

  const [envio, cfgRows, sinAsignar, suppliers, pedidosCaja, despiece99, repartidos, egresosCaja, itemsPendientesCosto, pagosFlete, couriers] = await Promise.all([
    db.envio.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: true, ensamble: true, pedido: true, supplier: true,
            // Lo que el proveedor no mandó todavía: la caja no lo espera al llegar.
            incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { id: true, tipo: true, estado: true, cantidad: true, pieza: true, nota: true, creadaAt: true }, orderBy: { id: 'asc' } },
          },
          orderBy: [{ pedidoId: 'asc' }, { id: 'asc' }],
        },
        // El proveedor de la caja: decide el precio de las piezas, cómo se cobra el tramo
        // a USA y qué etapas tiene la ruta de todo lo que va adentro.
        supplier: { select: { id: true, name: true, origen: true, inbound: true } },
        trackings: {
          select: {
            id: true, tramo: true, numero: true, transportista: true, courierCode: true, estado: true, subestado: true,
            ultimoEvento: true, ultimoEventoEn: true, eventos: true, consultadoEn: true, errorSeguimiento: true,
          },
          orderBy: { id: 'asc' },
        },
        cajas: { select: CAJA_SELECT, orderBy: { id: 'asc' } },
      },
    }),
    db.config.findMany(),
    db.pedidoItem.findMany({
      // Una caja express lleva solo presupuestos express, y una aérea los demás (motivoViaNoCoincide).
      where: { envioId: null, desdeStock: false, pedido: { tipo: { not: 'venta' }, status: { not: 'cancelado' }, via: ruta.modo === 'express' ? 'express' : 'normal' } },
      include: {
        product: { select: { nameEs: true, bajajCode: true, discontinuedAt: true } },
        ensamble: { select: { nameEs: true, nameEn: true } },
        pedido: true,
        incidencias: { where: { estado: 'abierta', tipo: 'sin_enviar' }, select: { id: true } },
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
        ensamble: { pedidoItems: { some: { envioId: id, supplierId: null, shippingStatus: 'pendiente', costRealUsd: null } } },
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
        pedido: { items: { some: { envioId: null, desdeStock: false } } },
      },
      select: { pedidoId: true, envio: { select: { id: true, nombre: true } } },
    }),
    // Plata que ya salió de la cuenta contra esta caja (ver registrarPagoProveedor):
    // "pagado" del giro se calcula en vivo sumando esto, nunca se cachea en Envio. Solo lo
    // que salda lo que se le debe al PROVEEDOR (mercancía, tramo, comisión del giro): un
    // flete anotado contra la caja se le pagó a Shoppre o a la naviera, y contarlo acá
    // reducía una deuda que sigue viva. Es la misma definición que usa cuentasPorPagar.
    // Menos lo que el proveedor devolvió por algo que no mandó (CATEGORIAS_REEMBOLSO_PROVEEDOR).
    // Fila por fila (no sumado) porque la pestaña Comprar lista los pagos de esta caja.
    db.movimiento.findMany({
      where: {
        envioId: { in: idsCompra },
        OR: [
          { tipo: 'egreso', categoria: { in: [...CATEGORIAS_PAGO_PROVEEDOR] } },
          { tipo: 'ingreso', categoria: { in: [...CATEGORIAS_REEMBOLSO_PROVEEDOR] } },
        ],
      },
      select: { id: true, tipo: true, monto: true, fecha: true, metodoPago: true, descripcion: true, envioId: true, itemsComprados: { select: { pedidoId: true } } },
      orderBy: [{ fecha: 'asc' }, { id: 'asc' }],
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
    // Los couriers de Ship24, para elegir el de cada tracking (lib/ship24.ts).
    listaCouriers(),
  ])

  if (!envio) notFound()
  const trackingActivo = apiKeyShip24() != null
  const onewayActivo = credencialesOneway() != null
  const guiasSalida = envio.trackings.filter(t => t.tramo === (envio.modo === 'express' && envio.reenvio !== 'por_kilo' ? 'venezuela' : 'usa'))
  // Los números de la caja para NumerosTramo: cada form manda todos (la acción reemplaza todo).
  const numeros: NumeroGuardado[] = envio.trackings.flatMap(t => esTramoTracking(t.tramo)
    ? [{ ...t, tramo: t.tramo, eventos: eventosGuardados(t.eventos), consultado: t.consultadoEn ? horaConsulta(t.consultadoEn) : null }]
    : [])
  const firmaNumeros = numeros.map(t => `${t.tramo}:${t.numero}:${t.courierCode ?? ''}:${t.transportista ?? ''}`).join('|')

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

  const pagadoProveedor = egresosCaja.reduce(
    (t, g) => t + (g.tipo === 'ingreso' ? -1 : 1) * parseFloat(g.monto.toString()), 0)
  const pagosCaja: PagoCaja[] = egresosCaja
    .filter(m => m.envioId === id && m.tipo === 'egreso')
    .map(m => ({
      id: m.id,
      fecha: fechaCorta(m.fecha),
      monto: parseFloat(m.monto.toString()),
      metodoPago: m.metodoPago,
      descripcion: m.descripcion,
      piezas: m.itemsComprados.length,
      pedidos: [...new Set(m.itemsComprados.map(i => i.pedidoId))].sort((a, b) => a - b),
    }))

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
  // Comprada = pagada (costo real cargado) o ya en camino, como en estadoLinea: registrar el pago
  // no mueve la etapa, y una línea pagada que sigue en «Por comprar» no se vuelve a comprar.
  const pagadas = new Set(envio.items.filter(it => it.costRealUsd != null).map(it => it.id))
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
  // esExpress = Shoppre directo a Venezuela. La express por USA (reenvío por kilo) se ve como la
  // aérea: depósito → Miami y One Way aéreo a Caracas, sin tope (lib/calc.ts expressPorUsa).
  const porUsa = modoEnvio === 'express' && envio.reenvio === 'por_kilo'
  const esExpress = modoEnvio === 'express' && !porUsa
  // Las cajas como las pesó y midió el transportista: si hubo reempaque, las que salen. Si
  // están cargadas mandan ellas y reemplazan a la suma de las piezas: lo que se factura es
  // lo que leyó la balanza, caja por caja. Ver lib/cajas-envio.ts.
  const cajasFisicas = envio.cajas.map(cajaFisica)
  const facturan = cajasQueSeFacturan(envio.reempaque, cajasFisicas)
  const medidas = medidasDeCajas(facturan.cajas)
  // Lo que en verdad facturaron los transportistas. Si ya se cargó, pisa al estimado de
  // tabla en el landed y el margen — igual que `medidas` con el peso, ver calcEnvio.
  const costoRealAereo = envio.shippingCostRealAereo != null ? parseFloat(envio.shippingCostRealAereo.toString()) : null
  const costoRealMaritimo = envio.shippingCostRealMaritimo != null ? parseFloat(envio.shippingCostRealMaritimo.toString()) : null
  // Quién lleva lo que pasa por un depósito: Shoppre (tabla) o el reenvío por kilo (₹/kg que
  // cotizaron para esta caja). Congelado al crear la caja, como el proveedor.
  const reenvioCaja = { tipo: reenvioDe(envio.reenvio), tarifaKgInr: dec(envio.tarifaKgInr), reempaqueInr: dec(envio.reempaqueInr) }
  const reenvioLabel = reenvioMeta(reenvioCaja.tipo).label
  const porKilo = reenvioCaja.tipo === 'por_kilo'
  const calc = calcEnvio(items, cfg, {
    proveedor,
    modo: modoEnvio,
    medidas,
    fleteFacturado: { aereoUsd: costoRealAereo, maritimoUsd: costoRealMaritimo },
    reenvio: reenvioCaja,
  })
  // El mismo envío costeado por la suma de las piezas y el estimado de tabla, para ver
  // cuánto se le escapaba al catálogo y a la tarifa. Solo tiene sentido cuando hay una caja
  // real contra la cual compararlo.
  const calcNeto = calc.caja.medido
    ? calcEnvio(items, cfg, { proveedor, modo: modoEnvio, reenvio: reenvioCaja })
    : null

  // El giro de las OTRAS cajas de esta compra (caja partida): lo pagado se lee junto, así que
  // lo debido también. Solo existe si la caja se partió.
  const otrasCompra = idsCompra.filter(x => x !== id)
  let giroOtrasUsd = 0
  if (otrasCompra.length > 0) {
    const cajasCompra = await db.envio.findMany({ where: { id: { in: otrasCompra } }, include: ENVIO_COSTEO_INCLUDE })
    const ctxCompra = await contextoCosteo(cajasCompra)
    giroOtrasUsd = cajasCompra.reduce((t, c) => t + (costearAereo(c, ctxCompra).calc.giro?.costoTotalUsd ?? 0), 0)
  }
  const giroCompraUsd = (calc.giro?.costoTotalUsd ?? 0) + giroOtrasUsd

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
    if (p.shippingStatus !== 'pendiente' || pagadas.has(p.itemId)) continue
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
      .filter(it => it.supplierId == null && it.shippingStatus === 'pendiente' && it.costRealUsd == null && it.origen !== 'china')
      .map(it => {
        const cab = cabeceraDeLinea(it)
        return {
          ensambleId: it.ensambleId,
          assemblyName: cab.nameEs,
          assemblySku: cab.bajajCode,
          compatibleModels: cab.compatibleModels,
          sourceUrl: it.ensamble?.sourceUrl ?? null,
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
    esCliente: seEntregaDesdeElPedido(it.pedido.tipo),
    sinPeso: faltantesByItem.get(it.id)?.sinPeso ?? 0,
    sinMedidas: faltantesByItem.get(it.id)?.sinMedidas ?? 0,
    sinEnviar: textoSinEnviar(sinEnviarDe(it.incidencias)),
    admiteNoVino: (it.pedido.tipo === 'cliente' || it.pedido.tipo === 'propio') && it.pedido.status === 'pedido' && !it.isLanded &&
      tiposPara({ shippingStatus: it.shippingStatus, costRealUsd: it.costRealUsd != null ? Number(it.costRealUsd) : null }).includes('sin_enviar'),
    ...(() => {
      const se = sinEnviarDe(it.incidencias)
      const sets = Math.min(it.quantity, se.lineaEntera)
      return {
        skusNoVino: ((it.bundleItems as BundlePiece[] | null) ?? []).map(p => ({
          etiqueta: etiquetaPieza(p),
          quantity: p.quantity,
          yaAnotadas: p.quantity * sets + (se.porPieza.get(etiquetaPieza(p)) ?? 0),
        })),
        yaNoVino: se.lineaEntera,
      }
    })(),
  }))

  // Pestaña Comprar: lo que el proveedor avisó que no tiene (un "no lo mandó" abierto) y lo comprado
  // que todavía no despachó, desde donde se anota ese aviso.
  const proveedorCaja = envio.supplier?.name ?? '99rpm'
  const salioDelDeposito = envio.items.some(it => statusIndex(it.shippingStatus) > statusIndex('en_shoppre'))
  // Las acciones de la línea entera (sacarla, pasarla a otra caja) van en su primera fila, y solo si
  // no viene nada de ella: de una que vino a medias, la caja lleva lo que vino.
  const codigosDe = (bundle: BundlePiece[] | null) => {
    const cs = (bundle ?? []).flatMap(p => (p.bajajCode ? [p.bajajCode] : []))
    return cs.length === 0 ? null : cs.length > 3 ? `${cs.slice(0, 3).join(', ')} +${cs.length - 3}` : cs.join(', ')
  }
  const sinStockFilas: SinStockFila[] = envio.items.flatMap(it => it.incidencias.map((inc, k) => ({
    incidenciaId: inc.id,
    itemId: it.id,
    lineaEntera: k === 0 && lineaNoViene(it.quantity, sinEnviarDe(it.incidencias), (it.bundleItems as BundlePiece[] | null) ?? []),
    pagadoUsd: inc.pieza == null && it.costRealUsd != null ? perdidaSugerida(Number(it.costRealUsd), it.quantity, inc.cantidad) : null,
    propio: it.pedido.tipo === 'propio',
    pedidoId: it.pedidoId,
    clientName: it.pedido.clientName,
    nombre: cabeceraDeLinea(it).nameEs,
    // La pieza ya trae su código en la etiqueta; de un conjunto entero, los códigos de sus piezas.
    sku: inc.pieza != null ? null : cabeceraDeLinea(it).bajajCode ?? codigosDe(it.bundleItems as BundlePiece[] | null),
    cantidad: inc.cantidad,
    pieza: inc.pieza,
    desde: fechaCorta(inc.creadaAt),
    nota: inc.nota,
  })))
  // El buscador por SKU: cada código de lo comprado que todavía no llegó a Venezuela, con lo que queda
  // sin anotar como "no vino" (las piezas de un conjunto, una por una).
  const itemPorId = new Map(envio.items.map(it => [it.id, it]))
  const piezasCompradas: PiezaComprada[] = itemRows
    .filter(r => r.admiteNoVino && (r.shippingStatus !== 'pendiente' || pagadas.has(r.id)))
    .flatMap((r): PiezaComprada[] => {
      const it = itemPorId.get(r.id)!
      const base = { itemId: r.id, pedidoId: r.pedidoId, clientName: r.clientName, propio: it.pedido.tipo === 'propio' }
      const bundle = (it.bundleItems as BundlePiece[] | null) ?? []
      if (bundle.length === 0) {
        return [{ ...base, key: `${r.id}::`, etiqueta: '', sku: r.bajajCode, nombre: r.nombre, conjunto: null, disponibles: r.quantity - r.yaNoVino }]
      }
      return bundle.map(p => {
        const e = etiquetaPieza(p)
        const ya = r.skusNoVino.find(s => s.etiqueta === e)?.yaAnotadas ?? 0
        return { ...base, key: `${r.id}::${e}`, etiqueta: e, sku: p.bajajCode, nombre: p.nameEs, conjunto: r.nombre, disponibles: p.quantity * r.quantity - ya }
      })
    })
    .filter(p => p.disponibles > 0)

  // Lo comprado que viaja en la caja, esté en la etapa que esté: la caja se cuenta cuando se
  // abre, aunque ya la hayas marcado en Venezuela (o entregado). Recibir pasa a "en Venezuela"
  // solo lo que todavía no llegó a esa etapa.
  // Lo que el proveedor no mandó (incidencias "sin_enviar" abiertas) no se espera en la mesa, y una
  // línea que no vino entera tampoco pasa a Recibido: se recibe a mano cuando llegue.
  const enCaja = envio.items.filter(it => !it.isLanded && it.shippingStatus !== 'pendiente')
  const sinEnviarPorItem = new Map(enCaja.map(it => [it.id, sinEnviarDe(it.incidencias)]))
  const noViene = (it: (typeof enCaja)[number]) =>
    lineaNoViene(it.quantity, sinEnviarPorItem.get(it.id)!, (it.bundleItems as BundlePiece[] | null) ?? [])
  const porRecibir = enCaja.filter(it => statusIndex(it.shippingStatus) < statusIndex('en_venezuela') && !noViene(it))
  const noVinieron = enCaja.filter(it => statusIndex(it.shippingStatus) < statusIndex('en_venezuela') && noViene(it))
  const aContar = piezasAContar(enCaja.map(it => ({
    nombre: cabeceraDeLinea(it).nameEs,
    codigo: cabeceraDeLinea(it).bajajCode,
    quantity: it.quantity,
    piezas: (it.bundleItems as BundlePiece[] | null) ?? [],
    sinEnviar: sinEnviarPorItem.get(it.id),
  })))
  // Las de peso estimado se ofrecen pesar al contarlas. Un conjunto solo guarda códigos, así
  // que se resuelve por código, y un código que comparten dos productos no se ofrece.
  // Solo corre con una caja en camino a Venezuela: el resto del tiempo no cruza la red.
  const codigosAContar = aContar.flatMap(p => (p.codigo ? [p.codigo] : []))
  if (codigosAContar.length > 0) {
    const prods = await db.product.findMany({
      where: { bajajCode: { in: codigosAContar } },
      select: { id: true, bajajCode: true, medidoAt: true, weightGrams: true, dimL: true, dimA: true, dimH: true },
    })
    for (const p of aContar) {
      const mismos = prods.filter(x => x.bajajCode === p.codigo)
      const x = mismos.length === 1 ? mismos[0] : null
      p.estimada = x && x.medidoAt == null
        ? { productId: x.id, weightGrams: x.weightGrams, dimL: x.dimL, dimA: x.dimA, dimH: x.dimH }
        : null
    }
  }

  // Lo confirmado (status='pedido') es lo que hay que comprar sí o sí; los
  // presupuestos sin aprobar todavía pueden caerse, así que se separan y nunca
  // entran al agregado masivo.
  // Una caja aérea lleva solo pedidos de su mismo reenvío (motivoReenvioNoCoincide): los del otro
  // no se ofrecen, pero se cuentan para que no parezca que se perdieron.
  const cajaReenvio = { modo: envio.modo, reenvio: envio.reenvio, despachaProveedor: inboundCaja === 'cotizado' }
  const entraPorReenvio = (it: (typeof sinAsignar)[number]) => motivoReenvioNoCoincide(it.pedido, cajaReenvio) == null
  const pedidosDelOtroReenvio = new Set(sinAsignar.filter(it => !entraPorReenvio(it)).map(it => it.pedidoId)).size
  const agruparSueltos = (pred: (p: (typeof sinAsignar)[number]) => boolean) => {
    const m = new Map<number, typeof sinAsignar>()
    for (const it of sinAsignar) {
      if (!pred(it) || !entraPorReenvio(it)) continue
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
      esperaCaja: it.incidencias.length > 0 && (it.costRealUsd != null || it.shippingStatus !== 'pendiente'),
    }))
  const otrasCajasDe = (pedidoId: number): EnOtraCaja[] =>
    Array.from(repartoPorPedido.get(pedidoId)?.values() ?? []).sort((a, b) => a.envioId - b.envioId)

  const anyMissing = calc.lines.some(l => l.missingWeight || l.missingDims)
  // Los escalones de la tabla solo existen en Shoppre: el reenvío por kilo cotiza cada caja.
  // Con varias cajas reales cargadas, cuántas son es un hecho y no un consejo que dar.
  const tierHint = porKilo || esExpress || calc.caja.cajas > 1 ? null : airTierHint(calc.air.chargeableKg, calc.air.costPerKgUsd, calc.air.cajas, calc.air.capKg)
  const fmtBound =
    calc.air.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  const meta = inboundMeta(inboundCaja)

  // La tarifa ₹/kg más alta que conviene aceptar del reenvío por kilo para ESTA caja: Shoppre
  // estimado (tabla + seguro + processing) sobre los kg cobrables. El reempaque se cancela.
  const calcPorShoppre = porKilo && modoEnvio === 'aereo' && calc.air.items > 0 ? calcEnvio(items, cfg, { proveedor, modo: modoEnvio, medidas }) : null
  const equilibrioInr = calcPorShoppre
    ? tarifaEquilibrioKgInr({
        shoppreUsd: calcPorShoppre.air.costUsd + calcPorShoppre.insuranceUsd + calcPorShoppre.processingUsd,
        // Lo que factura el por kilo (escalones de 0,5, mínimo 1): es contra eso que se paga la tarifa.
        chargeableKg: calc.reenvio.kgFacturados,
        inrUsd,
      })
    : null
  // Lo que cobra el depósito por caja (₹/kg del por kilo, reempaque): solo si algo pasa por uno.
  const pasaPorDeposito = !esCbm && inboundCaja !== 'cotizado'

  // A qué cajas se puede pasar un presupuesto (caja partida en el depósito, ver lib/mover-caja.ts):
  // las confirmadas del mismo proveedor, modo y reenvío que sean de esta compra o de ninguna. La
  // acción lo vuelve a revisar todo con las filas bloqueadas.
  const origenMover: CajaParaMover = {
    id, modo: envio.modo, estado: envio.estado, supplierId: envio.supplierId, reenvio: envio.reenvio,
    despachaProveedor: inboundCaja === 'cotizado',
    lineas: envio.items.map(it => ({ shippingStatus: it.shippingStatus, isLanded: it.isLanded })),
    fleteAereoPagado: pagosFlete.some(m => m.categoria === TRAMOS_FLETE.aereo.categoria),
    compraDeId: envio.compraDeId,
    tieneHijas: raizCompra === id && familia.length > 1,
  }
  const candidatasMover = await db.envio.findMany({
    where: {
      id: { not: id }, modo: envio.modo, supplierId: envio.supplierId, reenvio: envio.reenvio, estado: 'confirmado',
      OR: [{ id: raizCompra }, { compraDeId: raizCompra }, { compraDeId: null, partes: { none: {} } }],
    },
    select: {
      id: true, nombre: true, modo: true, estado: true, supplierId: true, reenvio: true, compraDeId: true,
      items: { select: { shippingStatus: true, isLanded: true } },
      movimientos: { where: { tipo: 'egreso', categoria: TRAMOS_FLETE.aereo.categoria }, select: { id: true } },
      _count: { select: { partes: true } },
    },
    orderBy: { id: 'desc' },
  })
  const motivosMover = candidatasMover.map(c => ({
    c,
    motivo: motivoNoMueve(origenMover, {
      id: c.id, modo: c.modo, estado: c.estado, supplierId: c.supplierId, reenvio: c.reenvio,
      despachaProveedor: inboundCaja === 'cotizado', lineas: c.items,
      fleteAereoPagado: c.movimientos.length > 0, compraDeId: c.compraDeId, tieneHijas: c._count.partes > 0,
    }),
  }))
  // Lo que depende solo de esta caja (borrador, ya salió, flete pagado), contra una caja ideal: si
  // pasa, también se ofrece una caja nueva de esta compra (la acción la crea en el mismo paso).
  const cajaIdeal: CajaParaMover = { ...origenMover, id: -1, estado: 'confirmado', lineas: [], fleteAereoPagado: false, tieneHijas: false }
  const motivoOrigen = motivoNoMueve(origenMover, cajaIdeal)
  const cajaNueva = { id: 'nueva' as const, nombre: '＋ Caja nueva (misma compra)' }
  const destinosMover = [
    ...motivosMover.filter(m => m.motivo == null).map(({ c }) => ({ id: c.id, nombre: c.nombre ?? `Caja #${c.id}` })),
    ...(motivoOrigen == null ? [cajaNueva] : []),
  ]
  // Una pieza sin stock no estuvo en el depósito: se pasa aunque esta caja ya haya salido.
  const destinosSinStock = [
    ...candidatasMover
      .filter(c => motivoNoMueveSinEnviar(origenMover, {
        id: c.id, modo: c.modo, estado: c.estado, supplierId: c.supplierId, reenvio: c.reenvio,
        despachaProveedor: inboundCaja === 'cotizado', lineas: c.items,
        fleteAereoPagado: c.movimientos.length > 0, compraDeId: c.compraDeId, tieneHijas: c._count.partes > 0,
      }) == null)
      .map(c => ({ id: c.id, nombre: c.nombre ?? `Caja #${c.id}` })),
    ...(motivoNoMueveSinEnviar(origenMover, cajaIdeal) == null ? [cajaNueva] : []),
  ]
  const motivoNoMover = destinosMover.length > 0 ? null : motivoOrigen

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
        tramo: 'aereo',
        titulo: esExpress ? 'Express Shoppre → Venezuela' : TRAMOS_FLETE.aereo.titulo,
        icono: esExpress ? '⚡' : TRAMOS_FLETE.aereo.icono,
        facturadoUsd: costoRealAereo, calculadoUsd: calc.airCalculadoUsd,
        nota: porKilo
          ? `La factura de ${reenvioLabel} incluye el reempaque.`
          : 'La factura de Shoppre incluye el processing y el reempaque, y no lleva seguro.',
        pagos: pagosDe(TRAMOS_FLETE.aereo.categoria),
        guardar: guardarFleteReal.bind(null, envio.id, 'aereo'),
        pagar: pagarFlete.bind(null, envio.id, 'aereo'),
        deshacer: deshacerPagoFlete.bind(null, envio.id),
      })
    }
    // El express no tiene naviera: Shoppre lo lleva hasta Venezuela.
    if (!esExpress) {
      filasFlete.push({
        tramo: 'maritimo',
        titulo: porUsa ? 'One Way aéreo Miami → Caracas' : TRAMOS_FLETE.maritimo.titulo,
        icono: porUsa ? '✈️' : TRAMOS_FLETE.maritimo.icono,
        facturadoUsd: costoRealMaritimo, calculadoUsd: calc.maritimeCalculadoUsd + calc.fobUsd,
        pagos: pagosDe(TRAMOS_FLETE.maritimo.categoria),
        guardar: guardarFleteReal.bind(null, envio.id, 'maritimo'),
        pagar: pagarFlete.bind(null, envio.id, 'maritimo'),
        deshacer: deshacerPagoFlete.bind(null, envio.id),
      })
    }
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

  // «Actualizar trackings» va junto a las guías de cada tramo.
  const botonActualizar = (trackingActivo || onewayActivo) && (
    <FormConResultado action={actualizarTrackings.bind(null, envio.id)}>
      <PendingButton
        pendingLabel="Consultando…"
        className="min-h-9 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <span aria-hidden="true">↻ </span>Actualizar trackings
      </PendingButton>
    </FormConResultado>
  )

  // Pasos de la caja: qué falta hacer con ella. Nada se guarda, cada paso sale de datos que ya
  // existen (líneas, caja pesada, libro).
  const pagadoTramo = (cat: string) =>
    pagosFlete.filter(m => m.categoria === cat).reduce((acc, m) => acc + parseFloat(m.monto.toString()), 0)
  const compradas = envio.items.filter(it => it.shippingStatus !== 'pendiente' || pagadas.has(it.id)).length
  const entregadas = envio.items.filter(it => it.shippingStatus === 'entregado').length
  // Borrador = todavía se está pensando: no cuenta como inventario en camino y no se compra,
  // paga ni avanza (ver confirmarCajaAerea). Vuelve a borrador solo si no pasó nada todavía.
  const esBorrador = envio.estado === 'borrador'
  const puedeVolverABorrador = !esBorrador && compradas === 0 && lineasConCostoReal === 0
  // Cada paso dice en qué pestaña se resuelve y qué hay que hacer: el próximo es el botón principal.
  const pasos: { texto: string; hecho: boolean; tab: string; accion: string }[] = [
    { texto: 'Asignada', hecho: envio.items.length > 0, tab: 'contenido', accion: 'Agregar pedidos' },
    { texto: 'Confirmada', hecho: !esBorrador, tab: 'contenido', accion: 'Confirmar compra' },
    { texto: `Comprada ${compradas}/${envio.items.length}`, hecho: envio.items.length > 0 && compradas === envio.items.length, tab: 'comprar', accion: 'Comprar lo que falta' },
    { texto: 'Pesada', hecho: calc.caja.medido, tab: 'envio', accion: 'Pesar y medir las cajas' },
  ]
  if (calc.giro && giroCompraUsd > 0) {
    pasos.push({ texto: 'Proveedor pagado', hecho: pagadoProveedor >= giroCompraUsd - 0.01, tab: 'comprar', accion: 'Pagar al proveedor' })
  }
  if (!esCbm) {
    if (inboundCaja !== 'cotizado') {
      const e = estadoFlete(costoRealAereo, pagadoTramo(TRAMOS_FLETE.aereo.categoria)).clave
      pasos.push({
        texto: esExpress ? 'Flete express pagado' : 'Flete aéreo pagado', hecho: e === 'pagado' || e === 'de_mas',
        tab: 'plata', accion: esExpress ? 'Cargar y pagar el flete express' : 'Cargar y pagar el flete aéreo',
      })
    }
    if (!esExpress) {
      const em = estadoFlete(costoRealMaritimo, pagadoTramo(TRAMOS_FLETE.maritimo.categoria)).clave
      const nombre = porUsa ? 'One Way' : 'marítimo'
      pasos.push({ texto: `Flete ${nombre} pagado`, hecho: em === 'pagado' || em === 'de_mas', tab: 'plata', accion: `Cargar y pagar el flete ${nombre}` })
    }
  }
  // Express: la caja entera contra el tope de landed (lib/express.ts). Con la caja pesada y la
  // factura de Shoppre cargadas, es el número real.
  const topeExpress = esExpress ? topeDeCaja(calc, cfg) : null
  const motivoTope = topeExpress ? motivoExpressNoAprobable(topeExpress) : null
  pasos.push({ texto: `Entregada ${entregadas}/${envio.items.length}`, hecho: envio.items.length > 0 && entregadas === envio.items.length, tab: 'contenido', accion: 'Entregar desde cada pedido' })
  const proximoPaso = pasos.find(p => !p.hecho)

  // La pestaña con la que abre la ficha: la del momento de la caja. El hash (#plata) le gana.
  const porComprar = envio.items.length - compradas
  const enCaminoAVenezuela = porRecibir.some(it => statusIndex(it.shippingStatus) >= statusIndex('camino_venezuela'))
  const tabInicial = items.length === 0 || esBorrador ? 'contenido'
    : porComprar > 0 ? 'comprar'
      : enCaminoAVenezuela ? 'llegada'
        : porRecibir.length > 0 ? 'envio'
          : 'contenido'
  const margenPct = financiamiento.ventaTotalUsd > 0 ? (financiamiento.margenTotalUsd / financiamiento.ventaTotalUsd) * 100 : null
  const modoMeta = MODOS.find(m => m.value === modoEnvio)

  return (
    <div className="max-w-screen-2xl">
      <header className="mb-5">
        <nav aria-label="Ruta" className="flex items-center gap-2 mb-1">
          <Link href="/envios" className="text-gray-500 hover:text-gray-700 text-sm">Envíos</Link>
          <span aria-hidden="true" className="text-gray-300">/</span>
          <span className="text-sm text-gray-600">#{envio.id}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900 break-words">{envio.nombre ?? `Envío #${envio.id}`}</h1>
              {/* Modo con el que se costeó esta caja: se congeló al crearla. */}
              <span
                title={modoMeta?.hint}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${modoEnvio === 'express' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-800'}`}
              >
                <span aria-hidden="true">{modoMeta?.icon}</span> {modoMeta?.label}
                {esExpress && ' · Shoppre directo a Venezuela'}
                {porUsa && ' · por USA (DDP), sin tope'}
              </span>
              {porKilo && (
                <span title={reenvioMeta('por_kilo').hint} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-100 text-violet-800">
                  {reenvioLabel}
                </span>
              )}
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${esBorrador ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>
                {esBorrador ? 'Borrador' : 'Confirmada'}
              </span>
            </div>
            {envio.notas && <p className="text-sm text-gray-500 mt-1">{envio.notas}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {esBorrador && items.length > 0 ? (
              <FormConResultado action={confirmarCajaAerea.bind(null, envio.id)} className="flex flex-wrap items-center gap-2">
                <PendingButton className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
                  Confirmar compra
                </PendingButton>
              </FormConResultado>
            ) : !esBorrador && proximoPaso ? (
              <a
                href={`#${proximoPaso.tab}`}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
              >
                {proximoPaso.accion}
              </a>
            ) : null}
            {!esBorrador && aContar.length > 0 && enCaminoAVenezuela && <BotonConteo yaRecibida={false} />}
            <details className="relative">
              <summary className="list-none cursor-pointer px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 font-medium text-gray-700 [&::-webkit-details-marker]:hidden">
                Más <span aria-hidden="true">▾</span>
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg space-y-3">
                {puedeVolverABorrador ? (
                  <FormConResultado action={volverCajaABorrador.bind(null, envio.id)}>
                    <PendingButton className="text-sm text-gray-700 hover:text-gray-900 underline disabled:opacity-50">
                      Volver a borrador
                    </PendingButton>
                  </FormConResultado>
                ) : !esBorrador && (
                  <p className="text-xs text-gray-500">No vuelve a borrador: ya hay líneas compradas o con costo real.</p>
                )}
                {/* El flete no se "guarda": la lista de envíos lo calcula en vivo (lib/costo-envios). */}
                <div className="flex flex-wrap items-center gap-2">
                  <DeleteButton
                    action={deleteEnvio.bind(null, envio.id)}
                    label="Eliminar caja"
                    confirmMessage={`¿Eliminar el envío "${envio.nombre ?? `#${envio.id}`}"? Los ítems quedarán libres.`}
                  />
                </div>
              </div>
            </details>
          </div>
        </div>
        {esBorrador && (
          <p className="mt-2 text-sm text-gray-600">
            Borrador: todavía no es una compra. No cuenta como inventario en camino y no se compra, paga ni mueve.
          </p>
        )}
        {motivoTope && esBorrador && (
          <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
            No se puede confirmar así: {motivoTope}
          </p>
        )}
        {/* Qué le falta a la caja, derivado de lo que ya hay cargado. El próximo paso lleva a su pestaña. */}
        {items.length > 0 && (
          <ol aria-label="Pasos de la caja" className="flex flex-wrap items-center gap-1.5 mt-3">
            {pasos.map(p => (
              <li
                key={p.texto}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  p.hecho ? 'bg-green-100 text-green-800' : p === proximoPaso ? 'bg-amber-100 text-amber-900' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {p.hecho ? (
                  <><span aria-hidden="true">✓ </span>{p.texto}<span className="sr-only"> (hecho)</span></>
                ) : p === proximoPaso ? (
                  <a href={`#${p.tab}`} className="underline underline-offset-2 hover:no-underline">
                    {p.texto}: {p.accion.toLowerCase()} <span aria-hidden="true">→</span><span className="sr-only"> (próximo paso)</span>
                  </a>
                ) : (
                  <><span aria-hidden="true">○ </span>{p.texto}</>
                )}
              </li>
            ))}
          </ol>
        )}
      </header>

      {/* Los números que se miran siempre. El resto vive en su pestaña. */}
      {items.length > 0 && (
        <dl aria-label="Resumen de la caja" className="grid grid-cols-2 lg:grid-cols-5 gap-px overflow-hidden rounded-xl border border-gray-100 bg-gray-100 shadow-sm mb-5">
          {topeExpress ? (
            <Kpi
              titulo="Tope del paquete express"
              valor={usd(calc.landedUsd)}
              tono={topeExpress.excede ? 'text-red-700' : 'text-gray-900'}
              detalle={`de ${usd(topeExpress.topeUsd)} · ${topeExpress.excede ? `se pasa ${usd(-topeExpress.holguraUsd)}` : `quedan ${usd(topeExpress.holguraUsd)}`}${calc.caja.medido ? '' : ' · suma de piezas'}`}
            >
              <span aria-hidden="true" className="mt-2 block h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <span
                  className={`block h-full rounded-full ${topeExpress.excede ? 'bg-red-500' : calc.landedUsd > topeExpress.topeUsd * 0.85 ? 'bg-amber-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(calc.landedUsd / topeExpress.topeUsd, 1) * 100}%` }}
                />
              </span>
            </Kpi>
          ) : (
            <Kpi
              titulo="Costo landed"
              valor={usd(calc.landedUsd)}
              detalle={`real al ${realPct.toFixed(0)}%`}
            />
          )}
          {calc.air.items > 0 ? (
            <Kpi
              titulo="Peso cobrable"
              valor={kg(calc.air.chargeableKg)}
              detalle={calc.caja.medido
                ? `${calc.caja.cajas} ${calc.caja.cajas === 1 ? 'caja pesada' : 'cajas pesadas'} · atado por ${calc.air.binding === 'weight' ? 'peso' : 'volumen'}`
                : `suma de piezas, sin empaque · atado por ${calc.air.binding === 'weight' ? 'peso' : 'volumen'}`}
            />
          ) : calc.tramo ? (
            <Kpi titulo="Peso real" valor={kg(calc.tramo.leg.realKg)} detalle={`lo despacha ${calc.tramo.nombre}`} />
          ) : (
            <Kpi titulo="Peso cobrable" valor="—" detalle="nada viaja por peso" />
          )}
          <Kpi
            titulo="Margen bruto"
            valor={margenPct != null ? usd(financiamiento.margenTotalUsd) : '—'}
            tono={financiamiento.margenTotalUsd < 0 ? 'text-red-700' : 'text-gray-900'}
            detalle={margenPct != null ? `${margenPct.toFixed(0)}% sobre ${usd(financiamiento.ventaTotalUsd)}` : 'sin venta todavía'}
          />
          <Kpi
            titulo="De tu bolsillo"
            valor={usd(financiamiento.bolsilloUsd)}
            tono="text-amber-800"
            detalle={`adelantos cubren ${usd(financiamiento.adelantosUsd)}`}
          />
          {/* Lo que salió del depósito: las guías del tramo largo (a USA, o directo a Venezuela en express). */}
          <Kpi
            className="col-span-2 lg:col-span-1"
            titulo={esExpress ? 'Paquete despachado' : 'Bultos despachados'}
            valor={guiasSalida.length > 0 ? String(guiasSalida.length) : '—'}
            detalle={guiasSalida.length === 0
              ? 'todavía no salió del depósito'
              : `${guiasSalida.filter(t => t.estado === 'delivered').length} entregados en ${esExpress ? 'Caracas' : 'Miami'}`}
          />
        </dl>
      )}

      <PestanasCaja
        inicial={tabInicial}
        pestanas={[
          {
            id: 'contenido',
            label: 'Contenido',
            badge: envio.items.length > 0 ? String(envio.items.length) : null,
            contenido: (
              <>
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center mb-4">
                    <p className="text-base font-semibold text-gray-900">Esta caja está vacía</p>
                    <p className="text-sm text-gray-600 mt-1">Agregá pedidos abajo para calcular el peso cobrable y el costo.</p>
                  </div>
                ) : (
                  <>
          <EnvioItemsTable
            envioId={envio.id}
            items={itemRows}
            inbound={inboundCaja}
            modo={modoEnvio}
            reenvio={envio.reenvio}
            guardar={saveItemChanges}
            quitar={removePedido}
            bloqueada={esBorrador}
            mover={moverPedidoACaja}
            destinos={destinosMover}
            motivoNoMover={motivoNoMover}
          />
                  </>
                )}
                <details id="agregar-pedidos" className="group bg-white rounded-xl shadow-sm border border-gray-100 mb-4" open={items.length === 0 || esBorrador}>
                  <summary className={SUMMARY_CLS}>
                    <span className="min-w-0">
                      <span className="block text-base font-semibold text-gray-900">{modoEnvio === 'express' ? 'Agregar presupuestos express' : 'Agregar pedidos'}</span>
                      <span className="block text-sm text-gray-600">
                        {confirmadosSinAsignar.length} {confirmadosSinAsignar.length === 1 ? 'confirmado' : 'confirmados'} con líneas sueltas
                        {' · '}{presupuestosSinAsignar.length} sin aprobar
                        {modoEnvio === 'express' && ' · solo entran presupuestos express'}
                      </span>
                    </span>
                    <span aria-hidden="true" className="mt-1 text-gray-500 transition-transform group-open:rotate-90">▶</span>
                  </summary>
                  {pedidosDelOtroReenvio > 0 && (
                    <p className="px-4 sm:px-6 pt-3 text-xs text-gray-500">
                      {pedidosDelOtroReenvio === 1 ? 'Un pedido suelto cotizado' : `${pedidosDelOtroReenvio} pedidos sueltos cotizados`}
                      {reenvioDe(envio.reenvio) === 'por_kilo' ? ' por Shoppre no se muestra' : ' por kilo no se muestra'}{pedidosDelOtroReenvio === 1 ? '' : 'n'}
                      {reenvioDe(envio.reenvio) === 'por_kilo' ? ': va en una caja Shoppre.' : ': va en una caja aérea por kilo.'}
                    </p>
                  )}
                  {confirmadosSinAsignar.length === 0 ? (
                    <p className="px-4 sm:px-6 py-4 text-sm text-gray-600">No hay pedidos confirmados con líneas sueltas.</p>
                  ) : (
                    <>
                      <FormConResultado
                        action={assignAllConfirmados.bind(null, envio.id)}
                        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-6 py-3"
                      >
                        <PendingButton
                          pendingLabel="Agregando…"
                          className="min-h-9 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                        >
                          Agregar {confirmadosSinAsignar.length === 1 ? 'el confirmado' : `los ${confirmadosSinAsignar.length} confirmados`}
                        </PendingButton>
                        {confirmadosPropios > 0 && (
                          <label className="flex items-center gap-2 text-sm text-gray-700 min-h-9">
                            <input type="checkbox" name="incluirPropio" defaultChecked className="h-4 w-4 rounded border-gray-300" />
                            Incluir stock propio ({confirmadosPropios})
                          </label>
                        )}
                      </FormConResultado>
                      <div className="divide-y divide-gray-100 border-t border-gray-100">
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
                    </>
                  )}
                  {/* Los presupuestos sin aprobar pueden caerse: se agregan de a uno, nunca en el agregado masivo. */}
                  <h3 className="px-4 sm:px-6 pt-4 pb-1 border-t border-gray-100 text-sm font-semibold text-gray-700">
                    Presupuestos sin aprobar ({presupuestosSinAsignar.length}) · no entran en «Agregar los confirmados»
                  </h3>
                  {presupuestosSinAsignar.length === 0 ? (
                    <p className="px-4 sm:px-6 pb-4 text-sm text-gray-600">
                      No hay presupuestos pendientes. <Link href="/presupuestos/new" className="text-blue-700 underline underline-offset-2">Creá uno</Link>.
                    </p>
                  ) : (
                    <div className="divide-y divide-gray-100">
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
                </details>
                {/* La caja entera (comprado o no) consolidada por SKU: lo que vale lo de adentro. */}
                {(buyIndia.length > 0 || buyChina.length > 0) && (
                  <details className="group bg-white rounded-xl shadow-sm border border-gray-100 mb-4">
                    <summary className={SUMMARY_CLS}>
                      <span className="min-w-0">
                        <span className="block text-base font-semibold text-gray-900">Contenido por SKU</span>
                        <span className="block text-sm text-gray-600">
                          {buyIndia.length + buyChina.length} {buyIndia.length + buyChina.length === 1 ? 'código' : 'códigos'}
                          {buyIndia.length > 0 && <> · {buyUnits} u. de India · {buyTotalInr > 0 && <>₹{Math.round(buyTotalInr).toLocaleString('es-VE')} ≈ </>}{usd(buyTotalUsd)}</>}
                          {buyChina.length > 0 && ` · ${buyChina.length} de China`}
                        </span>
                      </span>
                      <span aria-hidden="true" className="mt-1 text-gray-500 transition-transform group-open:rotate-90">▶</span>
                    </summary>
                    {buyIndia.length > 0 && (
                      <div className="relative overflow-x-auto">
                        <table className="w-full text-sm">
                          <caption className="px-4 sm:px-6 pt-3 pb-1 text-left text-sm font-semibold text-gray-700">India</caption>
                          <thead>
                            <tr className="border-b border-gray-100 text-xs text-gray-600">
                              <th scope="col" className="text-left px-4 sm:px-6 py-2 font-semibold">Código</th>
                              <th scope="col" className="text-left px-3 py-2 font-semibold">Pieza</th>
                              <th scope="col" className="text-right px-3 py-2 font-semibold">Cant.</th>
                              <th scope="col" className="text-right px-3 py-2 font-semibold">Unitario</th>
                              <th scope="col" className="text-right px-4 sm:px-6 py-2 font-semibold">Total USD</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {buyIndia.map((r, i) => (
                              <tr key={i}>
                                <td className="px-4 sm:px-6 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">{r.sku ?? '—'}</td>
                                <td className="px-3 py-2.5 text-gray-900 min-w-48">
                                  {r.name}
                                  {r.missingPrice && <span className="ml-2 text-xs font-semibold text-amber-800">sin precio</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                                <td className="px-3 py-2.5 text-right font-mono text-gray-600 whitespace-nowrap">
                                  {r.unit != null ? (r.moneda === 'USD' ? usd(r.unit) : `₹${r.unit.toLocaleString('es-VE')}`) : '—'}
                                </td>
                                <td className="px-4 sm:px-6 py-2.5 text-right font-mono font-semibold text-gray-900">{r.totalUsd > 0 ? usd(r.totalUsd) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-gray-200">
                              <th scope="row" colSpan={2} className="px-4 sm:px-6 py-3 text-left font-semibold text-gray-900">Total de la caja</th>
                              <td className="px-3 py-3 text-right font-mono font-semibold text-gray-700">{buyUnits}</td>
                              <td />
                              <td className="px-4 sm:px-6 py-3 text-right whitespace-nowrap">
                                <span className="font-bold font-mono text-blue-700">{usd(buyTotalUsd)}</span>
                                {buyTotalInr > 0 && (
                                  <span className="block text-xs text-gray-600 font-mono">₹{Math.round(buyTotalInr).toLocaleString('es-VE')} a {inrUsd}</span>
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                    {buyChina.length > 0 && (
                      <div className="relative overflow-x-auto border-t border-gray-100">
                        <table className="w-full text-sm">
                          <caption className="px-4 sm:px-6 pt-3 pb-1 text-left text-sm font-semibold text-gray-700">China</caption>
                          <thead>
                            <tr className="border-b border-gray-100 text-xs text-gray-600">
                              <th scope="col" className="text-left px-4 sm:px-6 py-2 font-semibold">Código</th>
                              <th scope="col" className="text-left px-3 py-2 font-semibold">Pieza</th>
                              <th scope="col" className="text-right px-4 sm:px-6 py-2 font-semibold">Cant.</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {buyChina.map((r, i) => (
                              <tr key={i}>
                                <td className="px-4 sm:px-6 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">{r.sku ?? '—'}</td>
                                <td className="px-3 py-2.5 text-gray-900 min-w-48">{r.name}</td>
                                <td className="px-4 sm:px-6 py-2.5 text-right font-mono text-gray-700">{r.qty}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </details>
                )}
              </>
            ),
          },
          {
            id: 'comprar',
            label: 'Comprar',
            badge: esBorrador ? null : sinStockFilas.length > 0 ? `${sinStockFilas.length} sin stock` : porComprar > 0 ? String(porComprar) : null,
            contenido: (
              <>
                {esBorrador ? (
                  <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-600 mb-4">
                    Confirmá la compra para ver la lista de lo que hay que comprar y registrar lo que pagaste. En borrador no se compra nada.
                  </p>
                ) : (
                  <>
                    <SinStockCaja
                      filas={sinStockFilas}
                      proveedor={proveedorCaja}
                      salio={salioDelDeposito}
                      resolver={resolverSinStock.bind(null, envio.id)}
                      sacar={envio.supplierId == null ? sacarSinStock.bind(null, envio.id) : null}
                      mover={moverSinStockACaja.bind(null, envio.id)}
                      separar={separarSinStock.bind(null, envio.id)}
                      destinos={destinosSinStock}
                      metodos={METODOS_PAGO_EGRESO}
                    />
                    {porComprar === 0 && items.length > 0 && (
                      <p role="status" className="rounded-xl border border-green-200 bg-green-50 px-4 sm:px-6 py-3 mb-4 text-sm text-green-800">
                        Todo lo de esta caja ya está comprado.
                      </p>
                    )}
                    {/* Lo pendiente de comprar, por ensamble para 99rpm, listo para copiar o bajar en CSV. */}
                    <PendientesCompraButton
                      envio={envio.nombre ?? `Envío #${envio.id}`}
                      grupos={pendientes}
                      inrUsd={inrUsd}
                      compra99={compra99}
                      lineas={porComprar}
                    />
                    <BuscarSinStock
                      piezas={piezasCompradas}
                      proveedor={proveedorCaja}
                      marcar={marcarSinStock.bind(null, envio.id)}
                    />
                    {/* Costo real de las piezas de ESTA caja: todo, por pedido o por SKU. La compra se anota
                        solo acá, nunca desde Contabilidad. */}
                    <RegistrarCompraPicker
                      items={itemsPendientesCosto}
                      action={registrarCompra}
                      methods={METODOS_PAGO_EGRESO}
                      collapsible
                      pagos={pagosCaja}
                    />
                  </>
                )}
                {/* Lo que se le paga al proveedor de la caja: el giro y sus dos comisiones. */}
                {calc.giro && (
                  <SeccionCaja
                    id="giro-titulo"
                    titulo={`${calc.giro.nombre}: lo que le pagás`}
                    sub={<>
                      Le girás <span className="font-mono font-semibold text-gray-900">{usd(calc.giro.montoUsd)}</span>
                      {' '}({usd(calc.giro.mercanciaUsd)} de mercancía{calc.giro.tramoUsd > 0 && ` + ${usd(calc.giro.tramoUsd)} de envío`}).
                      {inboundCaja === 'cotizado'
                        ? ' Despacha él a USA: no hay tarifa por kilo, se carga el total que te pasó.'
                        : porKilo
                          ? ` Entra por ${reenvioLabel}: el tramo es la tarifa ₹/kg de la pestaña Plata.`
                          : ' Entra por Shoppre: el tramo lo cobra la tabla escalón.'}
                    </>}
                    acciones={
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${inboundCaja === 'cotizado' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>
                        <span aria-hidden="true">{meta.icon} </span>{meta.label}
                      </span>
                    }
                  >
                    <div className="px-4 sm:px-6 py-4 space-y-3">
                      <FormConResultado action={saveCostosProveedor.bind(null, envio.id)} className="flex flex-wrap items-end gap-x-4 gap-y-3">
                        {/* El total del envío solo se pide a quien despacha por su cuenta: para una caja que
                            entra por un depósito ese número lo pone la tabla o la tarifa. */}
                        {inboundCaja === 'cotizado' && (
                          <CampoGiro
                            id="tramo-usd" name="tramoUsd" valor={tramoUsd} placeholder="0.00"
                            label="Envío + impuestos (USD)" ayuda="el total que te pasó, DDP"
                          />
                        )}
                        {/* Las dos puntas del giro van separadas porque se saben en momentos distintos. */}
                        <CampoGiro
                          id="comision-saliente" name="comisionSalienteUsd" valor={comisionSalienteUsd}
                          label="Comisión saliente (USD)"
                          ayuda={`lo que te cobró tu banco por girar ${usd(calc.giro.montoUsd)} · vacío = no lo sé, 0 = no cobró`}
                        />
                        <CampoGiro
                          id="comision-entrante" name="comisionEntranteUsd" valor={comisionEntranteUsd}
                          label="Comisión entrante (USD)"
                          ayuda="lo que le descontaron al recibir y le completaste · 0 = le llegó completo"
                        />
                        <PendingButton className="min-h-9 px-4 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                          Guardar
                        </PendingButton>
                      </FormConResultado>

                      {calc.tramo?.faltaCosto && (
                        <p className="text-sm text-amber-900 bg-amber-50 px-3 py-2 rounded-lg">
                          Sin el total del envío las piezas viajan gratis en el cálculo y toda la caja queda subcosteada.
                        </p>
                      )}
                      {!calc.giro.cargada && (
                        <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">
                          {!calc.giro.salienteCargada && !calc.giro.entranteCargada
                            ? 'Las dos comisiones están '
                            : !calc.giro.salienteCargada ? 'La comisión saliente está ' : 'La comisión entrante está '}
                          <strong>sin cargar</strong>: hoy cuenta{calc.giro.salienteCargada || calc.giro.entranteCargada ? '' : 'n'} como
                          $0 y el landed sale corto. Si esa punta no cobró nada, poné 0 y queda dicho.
                        </p>
                      )}
                      {calc.giro.cargada && calc.giro.comisionUsd > 0 && (
                        <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">
                          El giro te costó <span className="font-mono font-semibold">{usd(calc.giro.costoTotalUsd)}</span> en
                          total: {usd(calc.giro.montoUsd)} facturados + {usd(calc.giro.comisionSalienteUsd)} de saliente
                          + {usd(calc.giro.comisionEntranteUsd)} de entrante.
                        </p>
                      )}
                    </div>
                    {/* Plata que ya salió de la cuenta contra esta caja (libro), no lo facturado: son dos
                        números distintos a propósito. */}
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3 border-t border-gray-100">
                      <p className="text-sm text-gray-700">
                        Pagado <span className="font-mono font-semibold text-gray-900">{usd(pagadoProveedor)}</span>
                        {' de '}<span className="font-mono">{usd(giroCompraUsd)}</span>
                        {giroCompraUsd - pagadoProveedor > 0.01 && (
                          <> · faltan <span className="font-mono font-semibold text-amber-800">{usd(giroCompraUsd - pagadoProveedor)}</span></>
                        )}
                        {otrasCompra.length > 0 && (
                          <span className="block mt-1 text-gray-600">
                            Es una sola compra con{' '}
                            {familia.filter(f => f.id !== id).map((f, i) => (
                              <Fragment key={f.id}>
                                {i > 0 && ', '}
                                <Link href={`/envios/${f.id}`} className="text-blue-700 underline underline-offset-2">{f.nombre ?? `caja #${f.id}`}</Link>
                              </Fragment>
                            ))}
                            : lo pagado y lo debido son de todas juntas.
                          </span>
                        )}
                      </p>
                      {!esBorrador && <RegistrarPagoProveedorForm action={registrarPagoProveedor.bind(null, envio.id)} methods={METODOS_PAGO_EGRESO} />}
                    </div>
                  </SeccionCaja>
                )}
              </>
            ),
          },
          {
            id: 'envio',
            label: 'Envío',
            contenido: (
              <>
                <TrayectoCaja
                  trackings={envio.trackings}
                  express={esExpress}
                  paneles={{
                    local: (
                      <NumerosTramo
                        key={firmaNumeros}
                        tramo="local"
                        titulo={`${envio.supplier ? `De ${envio.supplier.name}` : 'Del proveedor'} al depósito de ${esExpress || !porKilo ? 'Shoppre' : reenvioLabel}`}
                        sub="El proveedor despacha la compra en 2 o 3 paquetes y da un número por cada uno."
                        todos={numeros}
                        couriers={couriers}
                        guardar={guardarTrackings.bind(null, envio.id)}
                        acciones={botonActualizar}
                      />
                    ),
                    [esExpress ? 'venezuela' : 'usa']: (
                      <>
                <NumerosTramo
                  key={firmaNumeros}
                  tramo={esExpress ? 'venezuela' : 'usa'}
                  titulo={esExpress ? 'Express a Venezuela: la guía del paquete' : 'Aéreo a USA: guías de lo que salió del depósito'}
                  sub={esExpress
                    ? 'Shoppre la lleva directo a Caracas, sin escala en USA. Su guía se sigue hasta la entrega.'
                    : 'Una guía por caja que sale hacia Miami, reempacada o no. Peso y medidas van más abajo.'}
                  todos={numeros}
                  couriers={couriers}
                  guardar={guardarTrackings.bind(null, envio.id)}
                  acciones={botonActualizar}
                />
                  {/* Las cajas reales: lo único que el catálogo no puede saber (pesa el bulto, no la pieza). */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                📦 Cajas · peso y medidas
              </h2>
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  calc.caja.medido ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {calc.caja.medido ? 'MEDIDA' : 'SIN MEDIR'}
              </span>
            </div>
            {/* El peso que se cobra, en una línea. El $/kg solo por Shoppre: el por kilo lo puso el dueño. */}
            {items.length > 0 && calc.air.items === 0 && calc.tramo && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600 mb-3">
                <span>DDP {calc.tramo.nombre}</span>
                <span>real <span className="font-mono text-gray-900">{kg(calc.tramo.leg.realKg)}</span></span>
                <span>vol <span className="font-mono text-gray-900">{kg(calc.tramo.leg.volKg)}</span></span>
                <span><span className="font-mono text-gray-900">{usd(calc.tramo.leg.costPerKgUsd)}</span>/kg facturado</span>
              </p>
            )}
            {items.length > 0 && calc.air.items > 0 && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600 mb-3">
                <span>Cobrable <span className="font-mono font-semibold text-blue-700">{kg(calc.air.chargeableKg)}</span></span>
                <span>real <span className="font-mono text-gray-900">{kg(calc.air.realKg)}</span></span>
                <span>vol <span className="font-mono text-gray-900">{kg(calc.air.volKg)}</span></span>
                {!porKilo && <span><span className="font-mono text-gray-900">{usd(calc.air.costPerKgUsd)}</span>/kg</span>}
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
              </p>
            )}
            {tierHint && <p className="text-xs text-gray-600 -mt-1 mb-3">{tierHint.text}</p>}
            {anyMissing && (
              <p className="text-xs mb-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-800">
                Algunas piezas no tienen peso o medidas: el cálculo las subestima. Están marcadas en la tabla de ítems.
              </p>
            )}
            <CajasEnvio
              key={`${envio.reempaque}|${envio.cajas.map(c => c.id).join(',')}`}
              action={guardarCajas.bind(null, envio.id)}
              reempaque={envio.reempaque}
              inicial={cajasFisicas}
              divisor={num(cfg, 'air_volumetric_divisor', 5000)}
            />
            {calc.caja.medido && (
              <div className="mt-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wide">
                      <th className="text-left font-medium pb-1"></th>
                      <th className="text-right font-medium pb-1">Suma de piezas</th>
                      <th className="text-right font-medium pb-1">{calc.caja.cajas > 1 ? 'Cajas reales' : 'Caja real'}</th>
                      <th className="text-right font-medium pb-1">Falta en el catálogo</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    <tr className="border-t border-gray-100">
                      <td className="py-2 font-sans text-gray-600">Peso</td>
                      <td className="py-2 text-right text-gray-500">{kg(calc.netRealKg)}</td>
                      <td className="py-2 text-right text-gray-900 font-semibold">{kg(calc.realKg)}</td>
                      <td className="py-2 text-right text-amber-700">{kg(calc.realKg - calc.netRealKg)}</td>
                    </tr>
                    <tr className="border-t border-gray-100">
                      <td className="py-2 font-sans text-gray-600">Volumen</td>
                      <td className="py-2 text-right text-gray-500">{m3(calc.netVolumeM3)}</td>
                      <td className="py-2 text-right text-gray-900 font-semibold">{m3(calc.volumeM3)}</td>
                      <td className="py-2 text-right text-amber-700">{m3(calc.volumeM3 - calc.netVolumeM3)}</td>
                    </tr>
                    {!esCbm && (
                      <tr className="border-t border-gray-100">
                        <td className="py-2 font-sans text-gray-600">Cobrable max(W,V)</td>
                        <td className="py-2 text-right text-gray-500">{kg(calcNeto!.air.chargeableKg)}</td>
                        <td className="py-2 text-right text-blue-700 font-semibold">{kg(calc.air.chargeableKg)}</td>
                        <td className="py-2 text-right text-gray-500">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>

              </div>
            )}
          </div>
                      </>
                    ),
                    ...(esExpress ? {} : {
                      venezuela: (
                        <NumerosTramo
                          key={firmaNumeros}
                          tramo="venezuela"
                          titulo="Miami → Caracas: courier interno"
                          sub={onewayActivo
                            ? 'El código de One Way Cargo (MT-…, CON-…, SB-…, CA-…) se sigue solo cada hora: anotalo sin elegir courier.'
                            : 'Casi nunca se sigue solo: si Ship24 no conoce el courier, la guía queda anotada y el estado lo sabés por el courier.'}
                          todos={numeros}
                          couriers={couriers}
                          guardar={guardarTrackings.bind(null, envio.id)}
                          acciones={botonActualizar}
                        />
                      ),
                    }),
                  }}
                >
                  {!trackingActivo && (
                    <p className="text-xs text-gray-600">
                      Seguimiento apagado: falta <code>{ENV_API_KEY}</code> en el servidor. Los números quedan solo anotados.
                    </p>
                  )}
                  {trackingActivo && couriers.length === 0 && (
                    <p className="text-xs text-amber-800">
                      Todavía no se bajó la lista de couriers de Ship24. Tocá «Actualizar trackings» y después elegí el courier de cada número.
                    </p>
                  )}
                </TrayectoCaja>
              </>
            ),
          },
          {
            id: 'llegada',
            label: 'Llegada',
            badge: !esBorrador && aContar.length > 0 && enCaminoAVenezuela ? String(aContar.length) : null,
            anclas: ['conteo'],
            contenido: (
              <>
                {esBorrador || aContar.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-600 mb-4">
                    {esBorrador ? 'En borrador no hay nada que contar.' : 'Todavía no hay nada comprado que contar.'}
                  </p>
                ) : (
                  <SeccionCaja
                    id="llegada-titulo"
                    titulo={porRecibir.length === 0 ? 'La caja ya está recibida' : enCaminoAVenezuela ? 'Contar lo que llegó y recibir' : 'Todavía no llegó a Venezuela'}
                    sub={<>
                      {aContar.length} {aContar.length === 1 ? 'código' : 'códigos'} a contar, los conjuntos abiertos en sus piezas.
                      {' '}{enCaminoAVenezuela || porRecibir.length === 0
                        ? 'Buscás el código, Enter suma uno; lo que falte se reporta como faltante en su pedido.'
                        : 'El conteo se hace cuando la caja va camino a Venezuela o llegó; podés abrirlo antes si hace falta.'}
                    </>}
                    acciones={<BotonConteo yaRecibida={porRecibir.length === 0} />}
                  />
                )}
          {!esBorrador && aContar.length > 0 && (
            <ConteoCaja
              envioId={envio.id}
              piezas={aContar}
              recibir={saveItemChanges.bind(null, envio.id, porRecibir.map(it => ({ id: it.id, shippingStatus: 'en_venezuela' })))}
              yaRecibida={porRecibir.length === 0}
              aviso={`${porRecibir.length > 0 ? `Pasa ${porRecibir.length} ${porRecibir.length === 1 ? 'línea' : 'líneas'} a "Recibido". ` : ''}${noVinieron.length > 0 ? `${noVinieron.length} ${noVinieron.length === 1 ? 'línea queda' : 'líneas quedan'} sin recibir porque el proveedor no la${noVinieron.length === 1 ? '' : 's'} mandó. ` : ''}Lo que falte, reportalo como incidencia "faltante" en su pedido.`}
            />
          )}
              </>
            ),
          },
          {
            id: 'plata',
            label: 'Plata',
            contenido: (
              <>
                {items.length > 0 && (
                  <SeccionCaja
                    id="landed-titulo"
                    titulo="Costo landed"
                    sub="Cada fila dice si el número es real o estimado."
                    acciones={
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        realPct >= 99.5 ? 'bg-green-100 text-green-800' : realPct >= 50 ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'
                      }`}>
                        Real al {realPct.toFixed(0)}%<span className="sr-only"> del costo sale de datos reales (pagos, facturas, tramo y comisiones cargados)</span>
                      </span>
                    }
                  >
                    <div className="grid gap-6 lg:grid-cols-2 px-4 sm:px-6 py-4">
                      <dl aria-label="Desglose del landed" className="space-y-2 text-sm">
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
                  {calc.air.items > 0 && (
                    <Row
                      label={`${esExpress ? 'Express Shoppre→Venezuela' : `Aéreo ${reenvioLabel}→USA`} · ${calc.air.chargeableKg.toFixed(1)} kg cobrables${calc.air.cajas > 1 ? ` en ${calc.air.cajas} cajas (${calc.air.cajasKg.map(k => `${k} kg`).join(' + ')})` : ''}${porKilo && costoRealAereo == null && (reenvioCaja.tarifaKgInr ?? calc.reenvio.tablaKgInr) != null ? ` · ${calc.reenvio.kgFacturados} kg facturables × ₹${(reenvioCaja.tarifaKgInr ?? calc.reenvio.tablaKgInr)!.toFixed(2)}/kg${reenvioCaja.tarifaKgInr == null ? ' (tabla)' : ''}` : ''}`}
                      value={usd(calc.air.costUsd)}
                      tag={costoRealAereo != null
                        ? { texto: 'facturado', tono: 'real' }
                        : calc.reenvio.faltaTarifa
                          ? { texto: 'sin cotizar', tono: 'falta' }
                          : porKilo && reenvioCaja.tarifaKgInr != null
                            ? { texto: 'cotizado', tono: 'est' }
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
                  {!esExpress && (
                    <Row
                      label={porUsa ? `One Way aéreo Miami→CCS · ${(calc.air.chargeableKg * LB_POR_KG).toFixed(1)} lb` : 'Marítimo USA→VEN (volumen)'}
                      value={usd(calc.maritimeUsd)}
                      tag={costoRealMaritimo != null
                        ? { texto: 'facturado', tono: 'real' }
                        : { texto: porUsa ? 'estimado por lb' : 'estimado por ft³', tono: 'est' }}
                    />
                  )}
                  {/* Seguro y processing son cargos de Shoppre: solo los paga lo que pasa por su
                      depósito, y solo se muestran si valen algo (la factura ya trae el processing
                      y Shoppre no cobra seguro: una fila en $0.00 es un cargo que no existe). */}
                  {calc.insuranceUsd > 0 && <Row label="Seguro Shoppre" value={usd(calc.insuranceUsd)} />}
                  {calc.processingUsd - calc.reenvio.reempaqueUsd > 0.005 && (
                    <Row label="Processing Shoppre" value={usd(calc.processingUsd - calc.reenvio.reempaqueUsd)} tag={{ texto: 'estimado', tono: 'est' }} />
                  )}
                  {calc.reenvio.reempaqueUsd > 0 && <Row label="Reempaque" value={usd(calc.reenvio.reempaqueUsd)} />}
                  {calc.reenvio.faltaReempaque && (
                    <Row label="Reempaque" value="—" tag={{ texto: 'sin cargar', tono: 'falta' }} />
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
                      <span className="text-xs text-gray-500">
                        ({((financiamiento.margenTotalUsd / financiamiento.ventaTotalUsd) * 100).toFixed(0)}%)
                      </span>
                    </dd>
                  </div>
                </>
              )}
                      </dl>
                      <QuienPonePlata f={financiamiento} />
                    </div>
                  </SeccionCaja>
                )}
                {/* Lo que cobra el depósito por ESTA caja: no hay número fijo que poner en /config. */}
                {pasaPorDeposito && (
                  <SeccionCaja
                    id="deposito-titulo"
                    titulo={`Lo que cobra el depósito${esExpress || !porKilo ? ' (Shoppre)' : ''} por esta caja`}
                    sub="La factura del flete aéreo, cuando la cargues, ya lo trae y lo reemplaza."
                  >
                    <div className="px-4 sm:px-6 py-4 space-y-3">
                      <FormConResultado action={guardarCotizacionDeposito.bind(null, envio.id)} className="flex flex-wrap items-end gap-x-4 gap-y-3">
                        {porKilo && (
                          <CampoGiro
                            id="tarifa-kg" name="tarifaKgInr" valor={reenvioCaja.tarifaKgInr}
                            // Vacío = la tabla de /config por el peso de esta caja.
                            placeholder={calc.reenvio.tablaKgInr != null ? `vacío = tabla (₹${calc.reenvio.tablaKgInr.toFixed(0)}/kg a este peso)` : tablaPorKilo(cfg) ? 'vacío = tabla de Configuración' : 'sin cotizar'}
                            label="Tarifa (₹ por kg cobrable)"
                            ayuda={`sobre ${kg(calc.reenvio.kgFacturados)} facturables (escalones de 0,5, mínimo 1)${equilibrioInr != null ? ` · conviene bajo ₹${equilibrioInr.toFixed(0)}/kg` : ''}`}
                          />
                        )}
                        <CampoGiro
                          id="reempaque" name="reempaqueInr" valor={reenvioCaja.reempaqueInr}
                          label="Reempaque (₹)" ayuda="lo que cobró por reempacar esta caja · 0 = no cobró"
                        />
                        <PendingButton className="min-h-9 px-4 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                          Guardar
                        </PendingButton>
                      </FormConResultado>
                      {calc.reenvio.faltaTarifa && (
                        <p className="text-sm text-amber-900 bg-amber-50 px-3 py-2 rounded-lg">
                          Sin tarifa (ni tabla en Configuración) el tramo a USA cuenta $0: la caja está subcosteada, no es gratis.
                        </p>
                      )}
                    </div>
                  </SeccionCaja>
                )}
                {/* Lo que cobraron los transportistas y si ya se les pagó. */}
          <FleteRealCard methods={METODOS_PAGO_EGRESO} filas={filasFlete} />
              </>
            ),
          },
        ]}
      />
    </div>
  )
}

function Kpi({ titulo, valor, detalle, tono = 'text-gray-900', className = '', children }: {
  titulo: string; valor: string; detalle?: string; tono?: string; className?: string; children?: ReactNode
}) {
  return (
    <div className={`bg-white px-4 py-3 min-w-0 ${className}`}>
      <dt className="text-xs font-medium text-gray-500">{titulo}</dt>
      <dd className="mt-1">
        <span className={`block text-xl font-bold font-mono ${tono}`}>{valor}</span>
        {detalle && <span className="block text-xs text-gray-500 mt-0.5">{detalle}</span>}
        {children}
      </dd>
    </div>
  )
}

// Quién pone la plata en la caja. La pregunta es de caja chica: para comprar esto hay que poner
// {costo}; una parte es de clientes que ya adelantaron (o deben), otra es inventario tuyo y otra
// un presupuesto que todavía no es venta. Separarlas dice cuánto es financiar y cuánto es invertir.
function QuienPonePlata({ f }: { f: FinanciamientoEnvio }) {
  if (f.costoUsd <= 0) return null
  return (
    <div className="space-y-3">
      <h3 id="plata-quien" className="text-sm font-semibold text-gray-700">Quién pone la plata</h3>
      <dl aria-labelledby="plata-quien" className="space-y-2 text-sm">
        <Row label="Clientes" value={usd(f.clientes.costoUsd)} />
        {f.propio.costoUsd > 0 && <Row label="Stock propio (inventario tuyo)" value={usd(f.propio.costoUsd)} />}
        {f.sinAprobar.costoUsd > 0 && <Row label="Presupuestos sin aprobar (riesgo)" value={usd(f.sinAprobar.costoUsd)} tag={{ texto: 'puede caerse', tono: 'falta' }} />}
        <Row label="Adelantos que la cubren" value={usd(f.adelantosUsd)} />
        <div className="flex justify-between gap-3 pt-3 mt-2 border-t-2 border-gray-200">
          <dt className="font-bold text-gray-900">De tu bolsillo hasta entregar</dt>
          <dd className="font-bold text-xl font-mono text-amber-800">{usd(f.bolsilloUsd)}</dd>
        </div>
      </dl>
      <p className="text-sm text-gray-600">
        {usd(f.clientes.porCobrarUsd)} por cobrar a clientes
        {f.propio.costoUsd > 0 && ` + ${usd(f.propio.costoUsd)} de inventario tuyo`}
        {f.sinAprobar.costoUsd > 0 && ` + ${usd(f.sinAprobar.costoUsd)} en riesgo`}.
        {f.pedidosPartidos > 0 && ` ${f.pedidosPartidos === 1 ? 'Un pedido está partido' : `${f.pedidosPartidos} pedidos están partidos`} entre cajas: su adelanto cuenta en proporción.`}
      </p>
      {f.clientes.pedidos > 0 && (
        <p className="text-sm">
          <Link href="/clientes" className="text-blue-700 underline underline-offset-2 hover:no-underline">
            Ver saldos de {f.clientes.pedidos === 1 ? 'este cliente' : `estos ${f.clientes.pedidos} clientes`}<span aria-hidden="true"> →</span>
          </Link>
        </p>
      )}
    </div>
  )
}

// Un monto del giro. Vacío = todavía no se sabe; 0 = es un hecho. La ayuda va a la vista (antes vivía en title).
function CampoGiro({ id, name, valor, label, ayuda, placeholder = 'sin cargar' }: {
  id: string; name: string; valor: number | null; label: string; ayuda: string; placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        id={id} name={name} type="number" step="0.01" min="0" inputMode="decimal"
        defaultValue={valor ?? ''} placeholder={placeholder} aria-describedby={`${id}-ayuda`}
        className="w-40 min-h-9 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      <p id={`${id}-ayuda`} className="text-xs text-gray-600 mt-1 max-w-[34ch]">{ayuda}</p>
    </div>
  )
}

// Encabezado de una sección plegable, igual al de SeccionCaja.
const SUMMARY_CLS = 'list-none cursor-pointer flex items-start justify-between gap-4 px-4 sm:px-6 py-4 rounded-xl hover:bg-gray-50 group-open:rounded-b-none group-open:border-b group-open:border-gray-100 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600'

const TAG_CLS = {
  real: 'bg-green-100 text-green-800',
  est: 'bg-gray-100 text-gray-700',
  falta: 'bg-amber-100 text-amber-900',
} as const

function Row({ label, value, tag }: { label: string; value: string; tag?: { texto: string; tono: keyof typeof TAG_CLS } }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-700 min-w-0">{label}</dt>
      <dd className="font-mono text-gray-900 flex flex-wrap justify-end items-baseline gap-x-2 shrink-0 max-w-[55%]">
        {tag && (
          <span className={`font-sans text-xs font-semibold px-1.5 py-0.5 rounded-full ${TAG_CLS[tag.tono]}`}>
            {tag.texto}
          </span>
        )}
        {value}
      </dd>
    </div>
  )
}
