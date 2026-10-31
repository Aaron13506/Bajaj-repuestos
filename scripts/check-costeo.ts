// ─────────────────────────────────────────────────────────────────────────────
// Chequeo de la aritmética de calcEnvio: una caja, un proveedor.
//
// Corre SIN base de datos, a propósito: lo que se verifica es el modelo de costo, no los
// datos. Existe porque el reparto de cargos dejó de ser "todo sobre todo" — el seguro y el
// processing son de Shoppre y solo los paga una caja que pase por Shoppre, el total del
// tramo solo lo pagan las piezas de la caja que lo facturó, y la comisión solo la caja del
// giro. Eso es fácil de romper en silencio: el total sigue dando parecido y lo que se
// desarma es el landed POR PIEZA, que es justo el número con el que se decide a quién
// comprarle.
//
// Se modelan las DOS cajas viajando en paralelo (una de Shoppre y una de Garuda), que es
// como se opera de verdad, para poder afirmar lo que más importa: que la de Garuda no
// paga nada de Shoppre y que la de Shoppre no paga nada de Garuda.
//
//   pnpm check:costeo
// ─────────────────────────────────────────────────────────────────────────────

import { calcEnvio, calcLanded, calcPrecioBcv, type ConfigMap, type EnvioItemInput, type ProveedorEnvio } from '../lib/calc'
import { telefonoIntl } from '../lib/utils'
import { mensajeEstado } from '../lib/mensajes-cliente'
import {
  compararCompra, MONTOS_VACIOS,
  type MontosProveedor, type PiezaCompra, type ProveedorOpcion,
} from '../lib/comparar-compra'
import { parseListaSkus } from '../lib/lista-skus'
import { cotizarTramoAereo, capacidadCajaKg, CARRIER_EXPRESS_VE } from '../lib/shipping-rates'
import { calcExpress, motivoExpressNoAprobable, viaDe } from '../lib/express'
import { repartirEnCentavos } from '../lib/reparto-compra'
import { financiamientoEnvio } from '../lib/financiamiento-envio'
import { estadoFlete, excedeFacturado, porSalirDeCaja, resumenFletes } from '../lib/flete-real'
import { motivoNoEliminable, type PedidoBorrable } from '../lib/pedido-eliminable'
import { motivoProveedorEnUso } from '../lib/proveedor-en-uso'
import { motivoProductoEnUso } from '../lib/producto-en-uso'
import { compatibleModelsFrom } from '../lib/modelo'
import { realDeCobro, resumenCobro } from '../lib/cobro-bcv'
import { construirResolver, piezasDeLinea } from '../lib/stock-piezas'
import { piezasAContar } from '../lib/conteo'
import { cuentaDeMetodo, datosBs, leerCobroBs } from '../lib/cuentas'
import { convertir, usdPorBsAlConvertir, usdPorBsEnCuenta } from '../lib/conversion'
import { costoDeLinea, motivoNoServible, motivoNoVendible, resumenVenta } from '../lib/venta-stock'
import { margenDePedido, mesDe, resultadoPorMes, type LineaMargen, type MargenPedido } from '../lib/margen'
import { cierreDe, embudo, estadoValidez, escalonDelPresupuesto, motivoNoAprobable, validezDias } from '../lib/validez'
import { describirOps, estadoLinea, permisoDeLinea, motivoEdicionSinCliente, planEdicion, repartirSobrante, type LineaActual, type LineaNueva } from '../lib/pedido-edicion'
import { devolucionSugerida, motivoDevolucionInvalida, motivoNoCancelable, resumenCancelacion } from '../lib/pedido-cancelacion'
import {
  bloqueaCompra, bloqueaEntrega, cerradosPorEdicion, dentroDePlazo, etiquetaPieza, motivoResolucionInvalida, origenPara, perdidaSugerida, planReembolso,
  resolucionesPara, tiposPara, type Resolucion,
} from '../lib/incidencias'
import { debeSaldo, motivoNoEntregable, saldoReal, seEntregaDesdeElPedido, situacionDeCobro } from '../lib/saldo-entrega'
import { diasSinMoverse, tiempoDeCompraA, tiemposPorTramo } from '../lib/etapas'
import { leerDevolucion } from '../lib/devolucion'
import { motivoNoCambiaReenvio, tarifaEquilibrioKgInr } from '../lib/reenvio'
import { leerTrackingsTramo, resumenTrackings, MAX_TRACKINGS_POR_TRAMO } from '../lib/tracking'

const cfg: ConfigMap = {
  inr_usd_rate: '94.95',
  miami_caracas_per_ft3: '35',
  shoppre_insurance_pct: '0.03',
  shoppre_processing_inr: '500',
  air_volumetric_divisor: '5000',
  shoppre_member: 'false',
  shoppre_carrier: 'ShipGlobal USA - Duty Free',
  reference_weight_kg: '11',
}

const GARUDA = 3
const OEMSHIP = 6

// ── Caja de Garuda: despacha él por India Post, precio por pieza en USD ──────
const itemsGaruda: EnvioItemInput[] = [
  { pedidoId: 1, productId: 101, name: 'Garuda A', weightGrams: 1200, dimL: 20, dimA: 15, dimH: 10,
    priceInr: null, priceUsd: 30, quantity: 2, origen: 'india', inbound: 'cotizado', supplierId: GARUDA },
  { pedidoId: 1, productId: 102, name: 'Garuda B', weightGrams: 800, dimL: 12, dimA: 10, dimH: 8,
    priceInr: null, priceUsd: 45, quantity: 1, origen: 'india', inbound: 'cotizado', supplierId: GARUDA },
]

// ── Caja de Shoppre: 99rpm/Oemship, tabla escalón sobre el peso de la caja ──
const itemsShoppre: EnvioItemInput[] = [
  { pedidoId: 2, productId: 201, name: 'Shoppre A', weightGrams: 2000, dimL: 25, dimA: 20, dimH: 15,
    priceInr: 4000, quantity: 1, origen: 'india', inbound: 'shoppre', supplierId: OEMSHIP },
  { pedidoId: 2, productId: 202, name: 'Shoppre B', weightGrams: 3500, dimL: 30, dimA: 22, dimH: 18,
    priceInr: 9500, quantity: 1, origen: 'india', inbound: 'shoppre', supplierId: OEMSHIP },
]

// El total DDP y las comisiones son montos anotados, no reglas: es lo que facturó Garuda,
// lo que cobró mi banco por emitir el giro y lo que le descontaron a él al acreditarlo.
const TRAMO_GARUDA = 180
const COMISION_SALIENTE = 30.7
const COMISION_ENTRANTE = 12.5
const COMISION_GARUDA = COMISION_SALIENTE + COMISION_ENTRANTE

const provGaruda: ProveedorEnvio = {
  supplierId: GARUDA,
  nombre: 'Garuda Impex',
  tramoUsd: TRAMO_GARUDA,
  comisionSalienteUsd: COMISION_SALIENTE,
  comisionEntranteUsd: COMISION_ENTRANTE,
}
const provOemship: ProveedorEnvio = { supplierId: OEMSHIP, nombre: 'Oemship' }

const g = calcEnvio(itemsGaruda, cfg, { proveedor: provGaruda })
const sh = calcEnvio(itemsShoppre, cfg, { proveedor: provOemship })

const usd = (n: number) => `$${n.toFixed(4)}`
let fallos = 0
function check(nombre: string, real: number, esperado: number, tol = 1e-6) {
  const ok = Math.abs(real - esperado) < tol
  if (!ok) fallos++
  console.log(`  ${ok ? '✓' : '✗'} ${nombre.padEnd(52)} ${usd(real).padStart(12)}  esperado ${usd(esperado)}`)
}

const garudaMerc = 30 * 2 + 45            // 105
const shoppreMerc = (4000 + 9500) / 94.95

// ── Caja de Garuda ───────────────────────────────────────────────────────────
console.log('\nCAJA DE GARUDA  (despacha él · DDP)')
console.log(`  tramo: ${g.tramo?.leg.items} piezas · ${g.tramo?.leg.chargeableKg.toFixed(3)} kg · ${usd(g.tramo?.costUsd ?? 0)}`)
check('mercancía', g.productCostUsd, garudaMerc)
check('no toca la tabla escalón de Shoppre', g.air.costUsd, 0)
check('tramo = el total que facturó', g.tramo!.costUsd, TRAMO_GARUDA)
check('el tramo se reparte entre sus piezas', g.lines.reduce((s, l) => s + l.airUsd, 0), TRAMO_GARUDA)
// Lo importante del DDP: ya pagó los impuestos de salida y no le declara nada a Shoppre.
check('sin seguro de Shoppre', g.insuranceUsd, 0)
check('sin processing de Shoppre', g.processingUsd, 0)
check('marítimo = ft³ × 35', g.maritimeUsd, g.volumeFt3 * 35)
check('giro = mercancía + tramo', g.giro!.montoUsd, garudaMerc + TRAMO_GARUDA)
check('comisión = las dos puntas, sin recalcular', g.comisionUsd, COMISION_GARUDA)
check('saliente = lo que cobró mi banco', g.giro!.comisionSalienteUsd, COMISION_SALIENTE)
check('entrante = lo que le descontaron a él', g.giro!.comisionEntranteUsd, COMISION_ENTRANTE)
check('costo real del giro = facturado + las dos', g.giro!.costoTotalUsd,
  garudaMerc + TRAMO_GARUDA + COMISION_GARUDA)
check('comisión repartida entre sus piezas', g.lines.reduce((s, l) => s + l.comisionUsd, 0), COMISION_GARUDA)
check('landed = producto + tramo + marítimo + comisión',
  g.landedUsd, garudaMerc + TRAMO_GARUDA + g.maritimeUsd + COMISION_GARUDA)
check('Σ landed por línea = landed total', g.lines.reduce((s, l) => s + l.landedUsd, 0), g.landedUsd)

// ── Caja de Shoppre ──────────────────────────────────────────────────────────
console.log('\nCAJA DE SHOPPRE  (tabla escalón de ShipGlobal)')
console.log(`  aéreo: ${sh.air.items} piezas · ${sh.air.chargeableKg.toFixed(3)} kg cobrables · ${usd(sh.air.costUsd)}`)
check('peso cobrable = solo sus piezas (2.0 + 3.5)', sh.air.chargeableKg, 5.5)
check('sin tramo cotizado', sh.tramo == null ? 0 : 1, 0)
check('seguro 3% sobre su mercancía', sh.insuranceUsd, shoppreMerc * 0.03)
check('processing (500 INR)', sh.processingUsd, 500 / 94.95)
check('sin comisión anotada, no se inventa ninguna', sh.comisionUsd, 0)
check('el giro existe igual, para poder anotarla', sh.giro == null ? 0 : 1, 1)
check('giro = su mercancía (Shoppre factura aparte)', sh.giro!.montoUsd, shoppreMerc)
check('Σ landed por línea = landed total', sh.lines.reduce((s, l) => s + l.landedUsd, 0), sh.landedUsd)

// ── Lo que las dos cajas NO se comparten ────────────────────────────────────
console.log('\nAISLAMIENTO ENTRE CAJAS')
check('el tramo de Garuda no aparece en la caja de Shoppre', sh.airUsd, sh.air.costUsd)
check('el seguro de Shoppre no aparece en la de Garuda', g.insuranceUsd + g.processingUsd, 0)
check('la comisión de Garuda no toca a Shoppre', sh.lines.reduce((s, l) => s + l.comisionUsd, 0), 0)

// ── El flete facturado pisa al estimado de tabla ────────────────────────────
// Mismo principio que `medidas` con el peso: una vez que se sabe lo que cobró el
// transportista de verdad, ese número reemplaza al estimado en el landed — pero el estimado
// queda disponible aparte (airCalculadoUsd/maritimeCalculadoUsd) para seguir comparando
// contra la factura, que es lo que usa el panel de /envios/[id].
console.log('\nFLETE FACTURADO PISA AL ESTIMADO')
const shAereoFacturado = calcEnvio(itemsShoppre, cfg, {
  proveedor: provOemship,
  fleteFacturado: { aereoUsd: sh.air.costUsd + 15 },
})
check('el facturado reemplaza al estimado del tramo Shoppre', shAereoFacturado.air.costUsd, sh.air.costUsd + 15)
check('el estimado original queda aparte, sin pisar', shAereoFacturado.airCalculadoUsd, sh.air.costUsd)
check('se repartió entre las piezas', shAereoFacturado.lines.reduce((s, l) => s + l.airUsd, 0), shAereoFacturado.air.costUsd)
check('Σ landed por línea sigue = landed total', shAereoFacturado.lines.reduce((s, l) => s + l.landedUsd, 0), shAereoFacturado.landedUsd)
// La factura de Shoppre trae el processing adentro: con ella cargada no se suma otra vez.
check('con la factura de Shoppre el processing no se suma encima', shAereoFacturado.processingUsd, 0)
check('el landed total subió el flete y bajó el processing que la factura ya incluye',
  shAereoFacturado.landedUsd, sh.landedUsd + 15 - sh.processingUsd)

const shMarFacturado = calcEnvio(itemsShoppre, cfg, {
  proveedor: provOemship,
  fleteFacturado: { maritimoUsd: sh.maritimeUsd + 22 },
})
check('el facturado reemplaza al estimado marítimo', shMarFacturado.maritimeUsd, sh.maritimeUsd + 22)
check('el estimado marítimo original queda aparte', shMarFacturado.maritimeCalculadoUsd, sh.maritimeUsd)
check('Σ landed por línea sigue = landed total (marítimo)', shMarFacturado.lines.reduce((s, l) => s + l.landedUsd, 0), shMarFacturado.landedUsd)
check('el landed total subió lo mismo que el flete marítimo', shMarFacturado.landedUsd, sh.landedUsd + 22)

// Una caja 100% Garuda no tiene líneas Shoppre: un "flete aéreo facturado" cargado ahí por
// error no debe inventarle costo a la caja entera — no hay a quién repartírselo.
const gConFacturadoDeMas = calcEnvio(itemsGaruda, cfg, {
  proveedor: provGaruda,
  fleteFacturado: { aereoUsd: 999 },
})
check('sin líneas Shoppre, el facturado aéreo no se aplica', gConFacturadoDeMas.air.costUsd, 0)
check('y el landed de Garuda no se mueve', gConFacturadoDeMas.landedUsd, g.landedUsd)

// ── Cargada en cero es un DATO; sin cargar es una ausencia ──────────────────
// Las dos suman 0 al landed, pero solo una significa "ya lo verifiqué". La pantalla
// necesita distinguirlas para no dar por cerrada una caja a la que le falta un número.
console.log('\nCERO EXPLÍCITO vs SIN CARGAR')
const sinNada = calcEnvio(itemsGaruda, cfg, {
  proveedor: { supplierId: GARUDA, nombre: 'Garuda Impex' },
})
check('sin el total del tramo, se marca faltaCosto', sinNada.tramo!.faltaCosto ? 1 : 0, 1)
check('sin comisión anotada, no se inventa ninguna', sinNada.comisionUsd, 0)
check('sin cargar NO queda marcada como cargada', sinNada.giro!.cargada ? 1 : 0, 0)

const enCero = calcEnvio(itemsGaruda, cfg, {
  proveedor: {
    supplierId: GARUDA, nombre: 'Garuda Impex', tramoUsd: TRAMO_GARUDA,
    comisionSalienteUsd: 0, comisionEntranteUsd: 0,
  },
})
check('cargada en 0 queda marcada como cargada', enCero.giro!.cargada ? 1 : 0, 1)

// Media comisión no es una comisión: mientras falte una punta el giro NO está costeado,
// aunque la otra ya sume al landed. Es la distinción que evita dar por cerrada una caja
// a la que le falta un número — que es exactamente lo que hacía la columna única.
const soloSaliente = calcEnvio(itemsGaruda, cfg, {
  proveedor: {
    supplierId: GARUDA, nombre: 'Garuda Impex', tramoUsd: TRAMO_GARUDA,
    comisionSalienteUsd: COMISION_SALIENTE,
  },
})
check('con una sola punta, el giro no está cargado', soloSaliente.giro!.cargada ? 1 : 0, 0)
check('pero la punta que sí está entra al landed', soloSaliente.comisionUsd, COMISION_SALIENTE)

// ─────────────────────────────────────────────────────────────────────────────
// Comparar la misma lista entre proveedores (/simular → "a quién le compro")
//
// Lo que se verifica acá no son totales sino el TOPE: el número que la pantalla existe
// para dar, porque cuando uno compara todavía no tiene la cotización de flete del
// proveedor. El tope se calcula restándole el tramo al landed, y esa resta solo es válida
// mientras nada más dependa del tramo. Si algún día el seguro o el processing pasaran a
// mirarlo, el tope seguiría saliendo un número plausible y estaría mal — que es
// exactamente el tipo de error que este script existe para atrapar.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCOMPARAR LA MISMA LISTA ENTRE PROVEEDORES')

const piezas: PiezaCompra[] = [
  { productId: 101, sku: 'JR161036', nombre: 'Pastilla', qty: 2,
    weightGrams: 340, dimL: 18, dimA: 6, dimH: 4, priceInr: 900 },
  { productId: 102, sku: 'JS121064', nombre: 'Retén', qty: 4,
    weightGrams: 60, dimL: 8, dimA: 8, dimH: 2, priceInr: 250 },
]

const proveedores: ProveedorOpcion[] = [
  { id: null, nombre: '99rpm (precio base)', origen: 'india', inbound: 'shoppre' },
  { id: GARUDA, nombre: 'Garuda Impex', origen: 'india', inbound: 'cotizado' },
  { id: OEMSHIP, nombre: 'Oemship', origen: 'india', inbound: 'shoppre' },
]

// Garuda cotiza las dos piezas; Oemship solo una — y esa cobertura parcial es justamente
// lo que hace ver barato a quien casi no cotiza.
const precios = [
  { supplierId: GARUDA, productId: 101, priceUsd: 8, isLanded: false, moq: null },
  { supplierId: GARUDA, productId: 102, priceUsd: 2, isLanded: false, moq: 10 },
  { supplierId: OEMSHIP, productId: 101, priceUsd: 7.5, isLanded: false, moq: null },
]

const cmp = (
  montos: Record<string, Partial<MontosProveedor>>,
  aplicarMoq = true,
) => compararCompra(
  piezas,
  proveedores,
  precios,
  cfg,
  Object.fromEntries(Object.entries(montos).map(([k, v]) => [k, { ...MONTOS_VACIOS, ...v }])),
  { aplicarMoq, referenciaId: null },
)

const base = cmp({})
const garuda = base.opciones.find(o => o.supplierId === GARUDA)!
const oemship = base.opciones.find(o => o.supplierId === OEMSHIP)!
const ref = base.referencia!

console.log(`  referencia (99rpm): ${usd(ref.landedUsd)} · Garuda sin flete: ${usd(garuda.landedSinTramoUsd)}`)
check('la referencia es 99rpm', ref.supplierId == null ? 1 : 0, 1)
check('Garuda cotiza las 2 piezas', garuda.cotizadas, 2)
check('Oemship cotiza 1 y la otra cae al precio base', oemship.cotizadas, 1)
check('Oemship deja 1 pieza sin cotizar', oemship.noCotizadas.length, 1)
// 99rpm es la base: su cobertura es completa por definición y no tiene huecos que
// avisar. Contárselos ponía "no cotiza 22 de 22, esas entran al precio base de 99rpm"
// en la tarjeta de 99rpm, que es donde el aviso no significa nada.
check('99rpm cubre todo: no tiene piezas sin cotizar', ref.noCotizadas.length, 0)
check('y cuenta como cotizadas las 2', ref.cotizadas, 2)
check('Garuda no paga seguro de Shoppre', garuda.b.insuranceUsd, 0)
check('Garuda no paga processing de Shoppre', garuda.b.processingUsd, 0)
check('99rpm sí paga processing', ref.b.processingUsd, 500 / 94.95)
check('el marítimo lo pagan las dos igual', garuda.b.maritimeUsd > 0 ? 1 : 0, 1)

// El MOQ sube la CANTIDAD, nunca el precio unitario: 4 pedidas contra un mínimo de 10.
check('el MOQ de Garuda obliga a 6 unidades de más', garuda.unidadesExtra, 6)
check('sin aplicar MOQ no sobra ninguna', cmp({}, false).opciones.find(o => o.supplierId === GARUDA)!.unidadesExtra, 0)

// EL TOPE. Cargándole exactamente ese flete, Garuda tiene que empatar con la referencia.
const tope = garuda.tramoTopeUsd!
const enElTope = cmp({ [String(GARUDA)]: { tramoUsd: tope } })
  .opciones.find(o => o.supplierId === GARUDA)!
check('con el tope cargado, empata con la referencia', enElTope.landedUsd, ref.landedUsd)
check('en el tope el ahorro es exactamente 0', enElTope.ahorroUsd, 0)

// Un dólar por encima del tope y pierde: el signo del ahorro es lo que se lee en pantalla.
const pasado = cmp({ [String(GARUDA)]: { tramoUsd: tope + 1 } })
  .opciones.find(o => o.supplierId === GARUDA)!
check('un dólar más de flete y pierde por un dólar', pasado.ahorroUsd, -1)

// Las comisiones del giro entran al landed tal cual, así que BAJAN el tope en la misma
// medida: es plata que sale de la misma compra. Las DOS puntas, no solo la que se ve en el
// estado de cuenta — la entrante es igual de real y se descubre después, que es justamente
// cuando el tope ya no sirve porque la compra está hecha.
const conComision = cmp({ [String(GARUDA)]: { comisionSalienteUsd: 8, comisionEntranteUsd: 4 } })
  .opciones.find(o => o.supplierId === GARUDA)!
check('las dos comisiones bajan el tope 1 a 1', conComision.tramoTopeUsd!, tope - 12)
const soloUna = cmp({ [String(GARUDA)]: { comisionSalienteUsd: 8 } })
  .opciones.find(o => o.supplierId === GARUDA)!
check('anotar solo la saliente no inventa la entrante', soloUna.tramoTopeUsd!, tope - 8)
check('99rpm no lleva giro (no hay a quién girarle)', ref.b.giro == null ? 0 : 1, 0)

// ── El tope por caja del transportista ──────────────────────────────────────
// La tabla de ShipGlobal termina en 22 kg porque ESE es el tope por caja, no porque al
// scraper se le haya cortado. Durante mucho tiempo el lookup saturaba en el último escalón,
// así que 24 kg pagaban lo mismo que 22 y 44 kg también: un error que no tiene techo y que
// además empuja para el lado peligroso, porque el aéreo se abarata al juntar kilos y el
// simulador terminaba premiando amontonar en una caja que no se puede despachar.
console.log('\nTOPE POR CAJA Y REPARTO DEL TRAMO AÉREO')
const CARRIER = cfg.shoppre_carrier!
const CAP = capacidadCajaKg(CARRIER)
const q = (kg: number) => cotizarTramoAereo(kg, CARRIER, false)

check('el tope por caja sale de la tabla', CAP, 22)
check('hasta el tope va en una sola caja', q(CAP).cajas, 1)
check('un gramo más ya son dos', q(CAP + 0.1).cajas, 2)
check('y cuesta más que la caja llena', q(CAP + 0.1).costUsd > q(CAP).costUsd ? 1 : 0, 1)
check('el doble del tope son dos cajas llenas', q(CAP * 2).costUsd, q(CAP).costUsd * 2, 0.011)
check('y no una sola saturada', q(CAP * 2).costUsd > q(CAP).costUsd ? 1 : 0, 1)
check('pasado el doble, tres', q(CAP * 2 + 1).cajas, 3)

// El reparto es en PARTES IGUALES, y eso es una decisión: el reparto más barato concentra
// peso en una caja (la tarifa baja por kilo cuanto más pesa), pero ese óptimo solo se logra
// eligiendo qué pieza va en cada caja, y el bulto lo reparte Shoppre. Costear el óptimo
// sería descontar un ahorro que no se va a lograr, y ese número termina en un precio de
// venta. Lo que sí tiene que cumplirse siempre: las cajas cubren el peso, ninguna pasa el
// tope, y el precio es el de esas cajas.
for (const kg of [22.1, 24, 30, 44, 46, 67]) {
  const r = q(kg)
  const suma = r.pesosKg.reduce((a, b) => a + b, 0)
  // Tolerancia de un centavo de kilo por caja: `pesosKg` viene redondeado para mostrarse,
  // el costo sale del peso sin redondear.
  check(`${kg} kg: las cajas cubren el peso`, Math.abs(suma - kg) <= 0.01 * r.cajas ? 1 : 0, 1)
  check(`${kg} kg: ninguna caja pasa el tope`, r.pesosKg.every(x => x <= CAP) ? 1 : 0, 1)
  check(`${kg} kg: todas las cajas pesan igual`, new Set(r.pesosKg).size, 1)
  check(`${kg} kg: el costo es el de sus cajas`, r.costUsd, q(kg / r.cajas).costUsd * r.cajas, 0.011)
  check(`${kg} kg: usa el mínimo de cajas`, r.cajas, Math.ceil(kg / CAP))
}

// Y el envío real tiene que verlo, no solo la función suelta.
const pesada: EnvioItemInput[] = [
  { pedidoId: 3, productId: 301, name: 'Pesada', weightGrams: 12000, dimL: 30, dimA: 25, dimH: 20,
    priceInr: 20000, quantity: 2, origen: 'india', inbound: 'shoppre', supplierId: OEMSHIP },
]
const bPesada = calcEnvio(pesada, cfg, { modo: 'aereo', proveedor: provOemship })
check('24 kg de mercancía viajan en dos cajas', bPesada.air.cajas, 2)
check('y el flete es el de las dos', bPesada.air.costUsd, q(24).costUsd, 0.011)
check('el tope viaja en el breakdown', bPesada.air.capKg ?? 0, CAP)

// ── La lista pegada ─────────────────────────────────────────────────────────
// El parseo es la puerta de entrada: si deja pasar un renglón de flete como si fuera una
// pieza, entra al embarque sin peso y sin precio y no se ve en ningún total.
console.log('\nLECTURA DE LA LISTA PEGADA')
const leida = parseListaSkus(`
{ "items": [
  { "sku": "JR161036", "qty": 2 },
  { "sku": "shipping", "qty": 1 },
  { "sku": "JR161036", "qty": 3 },
  { "nombre": "tapa sin codigo", "qty": 1 }
] }
`)
check('descarta el renglón de flete', leida.lineas.length, 1)
check('suma el SKU repetido', leida.lineas[0]?.qty ?? 0, 5)
check('el renglón sin código queda a la vista', leida.sinCodigo.length, 1)

const plano = parseListaSkus('JR161036 x2\nJS121064 4')
check('también lee texto plano', plano.lineas.length, 2)
check('y le saca la cantidad', plano.lineas[0]?.qty ?? 0, 2)

// ── Reparto de una compra ───────────────────────────────────────────────────
// Lo pagado de verdad es el único número real: lo repartido tiene que sumarlo AL CENTAVO.
// Redondear cada parte por separado no lo garantiza (3 × 3.33 = 9.99) y la diferencia es
// plata en el libro sin ninguna línea que la explique.
console.log('\nREPARTO DE UNA COMPRA')
const centavos = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100)
const tresIguales = repartirEnCentavos(10, [1, 1, 1])
check('tres partes iguales de $10 suman $10.00', centavos(tresIguales), 1000)
check('y ninguna se aparta más de un centavo', Math.max(...tresIguales) - Math.min(...tresIguales), 0.01, 0.0001)
const desigual = repartirEnCentavos(100, [3, 1])
check('el reparto es proporcional al estimado (75)', desigual[0], 75)
check('y (25)', desigual[1], 25)
const sinPesos = repartirEnCentavos(9, [0, 0, 0])
check('sin estimado en ninguna, a partes iguales', sinPesos[0], 3)
const diminuto = repartirEnCentavos(0.05, Array(10).fill(1))
check('$0.05 entre diez suma $0.05', centavos(diminuto), 5)
check('sin ninguna parte negativa', Math.min(...diminuto) >= 0 ? 1 : 0, 1)
// Barrido: muchas formas de lista, siempre exacto y nunca negativo.
let malos = 0
for (let n = 1; n <= 40; n++) {
  for (const monto of [0.01, 1, 17.77, 99.99, 1234.56]) {
    const pesos = Array.from({ length: n }, (_, i) => ((i * 7919) % 13) + (i % 3 === 0 ? 0 : 0.37))
    const r = repartirEnCentavos(monto, pesos)
    if (centavos(r) !== Math.round(monto * 100) || r.some(x => x < 0)) malos++
  }
}
check('200 combinaciones: siempre exacto y nunca negativo', malos, 0)

// ── Qué se puede borrar ─────────────────────────────────────────────────────
console.log('\nBORRADOS QUE ROMPEN HISTORIA')
const limpio: PedidoBorrable = {
  tipo: 'cliente', status: 'presupuesto', depositUsd: null, movimientos: 0,
  items: [{ envioId: null, shippingStatus: 'pendiente', costRealUsd: null }],
}
const bloqueado = (p: PedidoBorrable) => (motivoNoEliminable(p) != null ? 1 : 0)
check('un presupuesto sin historia se puede borrar', bloqueado(limpio), 0)
check('un pedido confirmado de cliente no', bloqueado({ ...limpio, status: 'pedido' }), 1)
check('con plata cobrada no', bloqueado({ ...limpio, depositUsd: 150 }), 1)
check('con movimientos en el libro no', bloqueado({ ...limpio, movimientos: 2 }), 1)
check('con una pieza en una caja no', bloqueado({ ...limpio, items: [{ envioId: 4, shippingStatus: 'pendiente', costRealUsd: null }] }), 1)
check('con una pieza ya comprada no', bloqueado({ ...limpio, items: [{ envioId: null, shippingStatus: 'camino_shoppre', costRealUsd: null }] }), 1)
check('con un costo real cargado no', bloqueado({ ...limpio, items: [{ envioId: null, shippingStatus: 'pendiente', costRealUsd: 12.5 }] }), 1)
check('stock propio sin historia sí (nace como pedido)', bloqueado({ ...limpio, tipo: 'propio', status: 'pedido' }), 0)
check('stock propio con una pieza entregada no', bloqueado({ ...limpio, tipo: 'propio', status: 'pedido', items: [{ envioId: 1, shippingStatus: 'entregado', costRealUsd: null }] }), 1)
const enUso = (u: { envios: number; pedidoItems: number; movimientos: number }) => (motivoProveedorEnUso(u) != null ? 1 : 0)
check('un proveedor sin historia se puede borrar', enUso({ envios: 0, pedidoItems: 0, movimientos: 0 }), 0)
check('con una caja no', enUso({ envios: 1, pedidoItems: 0, movimientos: 0 }), 1)
check('con líneas de pedido no', enUso({ envios: 0, pedidoItems: 3, movimientos: 0 }), 1)
check('con pagos en el libro no', enUso({ envios: 0, pedidoItems: 0, movimientos: 1 }), 1)

const prodEnUso = (u: { pedidoItems: number; envioLineas: number; ensambles: number }) => (motivoProductoEnUso(u) != null ? 1 : 0)
check('un producto sin uso se puede borrar', prodEnUso({ pedidoItems: 0, envioLineas: 0, ensambles: 0 }), 0)
check('en una línea de pedido no', prodEnUso({ pedidoItems: 2, envioLineas: 0, ensambles: 0 }), 1)
check('en un embarque marítimo no', prodEnUso({ pedidoItems: 0, envioLineas: 1, ensambles: 0 }), 1)
check('como componente de un ensamble no', prodEnUso({ pedidoItems: 0, envioLineas: 0, ensambles: 1 }), 1)

// ── Motos compatibles: editar no borra lo que el selector no sabe mostrar ───
console.log('\nMOTOS COMPATIBLES AL EDITAR')
const N250 = 'PULSAR_N250_DUAL_ABS_2022_23'
const N250_LABEL = 'Pulsar N250 Dual ABS 2022 23'
const DESCONOCIDA = 'Moto Que Aun No Esta En La Tabla'
const conExtra = `${N250_LABEL}, ${DESCONOCIDA}`
check('conserva una etiqueta desconocida al guardar sin tocar las motos',
  compatibleModelsFrom([N250], conExtra) === conExtra ? 1 : 0, 1)
check('quitar una moto de la tabla la saca, y la desconocida queda',
  compatibleModelsFrom([], conExtra) === DESCONOCIDA ? 1 : 0, 1)
check('agregar una moto de la tabla conserva la desconocida',
  compatibleModelsFrom([N250, 'PULSAR_N160_DUAL_ABS_2022_23'], DESCONOCIDA)
    === `Pulsar N160 Dual ABS 2022 23, ${N250_LABEL}, ${DESCONOCIDA}` ? 1 : 0, 1) // orden de catálogo: por cilindrada
check('sin motos y sin nada previo queda null', compatibleModelsFrom([], null) === null ? 1 : 0, 1)
check('un valor que no es id del enum se ignora', compatibleModelsFrom(['cualquier cosa'], null) === null ? 1 : 0, 1)

// ── Precio de venta y precio BCV: los números "redondos" tienen que seguir redondos ───
console.log('\nPRECIO FIJO Y PRECIO BCV')
{
  const r2 = (n: number) => Math.round(n * 100) / 100
  // 1) Con la brecha de cada escalón, el BCV cotizado vuelve EXACTO al precio al aplicarle el
  //    descuento de la brecha, para TODO precio en centavos (no solo 4, 5, 10).
  let malos = 0
  const ejemplos: string[] = []
  for (const brecha of [2, 8, 9.8, 12, 17, 24, 30, 45]) {
    const cfgB: ConfigMap = { bcv_usd_rate: '100', bcv_brecha_pct: String(brecha) }
    for (let cent = 1; cent <= 100000; cent++) {
      const precio = cent / 100
      const b = calcPrecioBcv(precio, cfgB)!
      const vuelve = r2(b.priceUsdBcv * (1 - b.brechaEscalonPct / 100))
      if (vuelve !== precio) { malos++; if (ejemplos.length < 3) ejemplos.push(`${precio}@${brecha}% → ${b.priceUsdBcv} → ${vuelve}`) }
    }
  }
  check('el BCV con el descuento aplicado vuelve al precio exacto (8 brechas × 100000 precios)', malos, 0)
  if (ejemplos.length) console.log('   ' + ejemplos.join(' | '))

  // 1b) La brecha llega como recargo sobre el BCV (paralelo / BCV − 1) y el escalón es un
  //     descuento sobre el precio BCV: se convierte antes de redondear. Brecha 40 es descuento
  //     28.6 → escalón 30, no 45 (con 45 el que paga en Bs dejaba un 30% de más).
  const escalonDe = (brecha: number) => calcPrecioBcv(1, { bcv_usd_rate: '100', bcv_brecha_pct: String(brecha) })!.brechaEscalonPct
  check('brecha 14.1 (descuento 12.4) → escalón 15', escalonDe(14.1), 15)
  check('brecha 16 (descuento 13.8) → escalón 15, no 20', escalonDe(16), 15)
  check('brecha 20 (descuento 16.7) → escalón 20, no 25', escalonDe(20), 20)
  check('brecha 40 (descuento 28.6) → escalón 30, no 45', escalonDe(40), 30)
  // Para toda brecha, el Bs cobrado a BCV vale en el paralelo al menos el precio en divisas
  // (1 / (1 − escalón) ≥ 1 + brecha), y el escalón queda entre 1 y 6 puntos por encima
  // del descuento real: el colchón del redondeo, nunca el error de escala.
  let bajoParidad = 0
  let fueraDeRango = 0
  for (let i = 0; i <= 950; i++) {
    const brecha = i / 10
    const escalon = escalonDe(brecha)
    if (1 / (1 - escalon / 100) < 1 + brecha / 100) bajoParidad++
    const sobre = escalon - (brecha / (100 + brecha)) * 100
    if (sobre < 1 - 1e-9 || sobre > 6 + 1e-9) fueraDeRango++
  }
  check('ninguna brecha (0 a 95) deja menos que el precio en divisas', bajoParidad, 0)
  check('el escalón queda entre 1 y 6 puntos sobre el descuento real (brecha 0 a 95)', fueraDeRango, 0)
  // El borde: brecha 16.28 es descuento 14.0, y con 1 punto de colchón ya paga el escalón 20.
  check('brecha 16.3 (descuento 14.02) → escalón 20', escalonDe(16.3), 20)
  check('brecha 16.2 (descuento 13.94) → escalón 15', escalonDe(16.2), 15)

  // 2) Un precio fijo manda: no se recompone desde landed y margen.
  const cfgP: ConfigMap = { inr_usd_rate: '95', bcv_usd_rate: '100', bcv_brecha_pct: '9', default_margin_pct: '33' }
  const base = { priceInr: 260, weightGrams: 120, dimL: 10, dimA: 8, dimH: 6, margin: 0.3163 }
  const sinFijo = calcLanded(base, cfgP, 'aereo')!
  const conFijo = calcLanded({ ...base, precioFijo: 4 }, cfgP, 'aereo')!
  check('con precio fijo, priceUsd es exactamente el escrito', conFijo.priceUsd ?? -1, 4)
  check('con precio fijo, el BCV sale de ese precio (brecha 9 → escalón 10%: 4 / 0.90 = 4.44)', conFijo.priceBcv?.priceUsdBcv ?? -1, 4.44)
  check('sin precio fijo se sigue derivando del margen', Math.abs((sinFijo.priceUsd ?? 0) - sinFijo.landedCostUsd / (1 - 0.3163)) < 1e-9 ? 1 : 0, 1)
}

// ── Quién pone la plata en la caja ──────────────────────────────────────────
console.log('\nQUIÉN PONE LA PLATA (financiamiento de la caja)')
{
  const it = (precio: number, quantity = 1) => ({ salePrice: precio, quantity })
  // Pedido 1: cliente confirmado, $200 en total, $100 de adelanto, la mitad viaja acá.
  // Pedido 2: stock propio. Pedido 3: presupuesto sin aprobar.
  const pedidos = [
    { id: 1, tipo: 'cliente', status: 'pedido', depositUsd: 100, items: [it(100), it(100)] },
    { id: 2, tipo: 'propio', status: 'pedido', depositUsd: null, items: [it(50)] },
    { id: 3, tipo: 'cliente', status: 'presupuesto', depositUsd: null, items: [it(30)] },
  ]
  const lineas = [
    { pedidoId: 1, landedUsd: 70, ventaUsd: 100 },
    { pedidoId: 2, landedUsd: 40, ventaUsd: 50 },
    { pedidoId: 3, landedUsd: 20, ventaUsd: 30 },
  ]
  const f = financiamientoEnvio(lineas, pedidos)
  check('el costo total es la suma de las líneas', f.costoUsd, 130)
  check('el adelanto se prorratea por la parte que viaja acá (100 × 100/200)', f.adelantosUsd, 50)
  check('de tu bolsillo = costo − adelanto prorrateado', f.bolsilloUsd, 80)
  check('el stock propio queda aparte, a costo', f.propio.costoUsd, 40)
  check('lo sin aprobar queda aparte', f.sinAprobar.costoUsd, 20)
  check('el margen es solo de clientes (100 − 70), sin la venta estimada del propio', f.margenClientesUsd, 30)
  check('un pedido partido se cuenta', f.pedidosPartidos, 1)
  // La otra mitad del pedido 1 en otra caja: entre las dos, el adelanto aplicado no pasa de lo pagado.
  const otra = financiamientoEnvio([{ pedidoId: 1, landedUsd: 70, ventaUsd: 100 }], [pedidos[0]])
  check('entre cajas, el adelanto aplicado no supera lo que pagó el cliente', f.adelantosUsd + otra.adelantosUsd, 100)
  // Un adelanto mayor al pedido nunca cubre más de lo vendido acá.
  const sobrepago = financiamientoEnvio(
    [{ pedidoId: 9, landedUsd: 10, ventaUsd: 20 }],
    [{ id: 9, tipo: 'cliente', status: 'pedido', depositUsd: 500, items: [it(20)] }],
  )
  check('el adelanto no cubre más que la venta de la caja', sobrepago.adelantosUsd, 20)
}

// ── Flete real: estado del pago y tope ──────────────────────────────────────
console.log('\nFLETE REAL (estado derivado del libro)')
{
  const c = (f: number | null, p: number) => estadoFlete(f, p).clave
  const uno = (b: boolean) => (b ? 1 : 0)
  check('sin factura ni pagos: sin cargar', uno(c(null, 0) === 'sin_cargar'), 1)
  check('facturado y nada pagado: por pagar', uno(c(316, 0) === 'por_pagar'), 1)
  check('pagado la mitad: parcial', uno(c(316, 100) === 'parcial'), 1)
  check('pagado exacto: pagado', uno(c(316, 316) === 'pagado'), 1)
  check('un centavo de diferencia sigue siendo pagado', uno(c(316, 315.995) === 'pagado'), 1)
  check('pagado de más se marca', uno(c(316, 320) === 'de_mas'), 1)
  check('un segundo pago completo se rechaza (doble click)', uno(excedeFacturado(316, 316, 316)), 1)
  check('el saldo exacto se acepta', uno(excedeFacturado(316, 100, 216)), 0)
  check('un pago de más de un centavo se rechaza', uno(excedeFacturado(316, 100, 216.5)), 1)
  check('resumen: un tramo por pagar manda', uno(resumenFletes([
    { facturadoUsd: 316, pagadoUsd: 316 }, { facturadoUsd: 48, pagadoUsd: 0 },
  ]) === 'por_pagar'), 1)
  const caja = { fleteAereoUsd: 316, pagadoAereoUsd: 0, fleteMaritimoUsd: 48, pagadoMaritimoUsd: 0, proveedorUsd: 20 }
  check('por salir: los dos tramos y el proveedor', porSalirDeCaja(caja), 384)
  check('por salir: lo pagado de un tramo se descuenta', porSalirDeCaja({ ...caja, pagadoAereoUsd: 316 }), 68)
  check('por salir: pagar de más un tramo no descuenta el otro', porSalirDeCaja({ ...caja, pagadoAereoUsd: 400 }), 68)
  check('por salir: proveedor sobrepagado no resta', porSalirDeCaja({ ...caja, proveedorUsd: -50 }), 364)
  check('resumen: todo pagado', uno(resumenFletes([
    { facturadoUsd: 316, pagadoUsd: 316 }, { facturadoUsd: 48, pagadoUsd: 48 },
  ]) === 'pagado'), 1)
}

// ── Cobro a dólar BCV: lo guardado es real, lo cobrado en Bs se escribe en BCV ──────────
console.log('\nCOBRO A DÓLAR BCV (pedido confirmado)')
{
  const r2 = (n: number) => Math.round(n * 100) / 100
  // El caso que lo destapó: Chain Kit a $80 reales, escalón 15% → $94.12 BCV, y un adelanto
  // de $47.06 pagado en Bs. Se guardaba 47.06 como si fueran dólares reales: saldo $32.94.
  const lineas = [{ salePrice: 80, quantity: 1 }]
  const r0 = resumenCobro(lineas, 0, 15)
  check('total BCV = 80 / 0.85', r0.totalBcv, 94.12)
  const adelanto = realDeCobro(47.06, true, r0, { bcv: r0.totalBcv, real: r0.totalReal })
  check('adelanto de $47.06 BCV en Bs se guarda como $40 reales', adelanto, 40)
  const r1 = resumenCobro(lineas, adelanto, 15)
  check('saldo BCV tras el adelanto', r1.saldoBcv, 47.06)
  check('saldo en divisas tras el adelanto', r1.saldoReal, 40)
  check('lo abonado se muestra en BCV', r1.abonadoBcv, 47.06)
  check('pagar el saldo BCV en Bs lo deja en cero', resumenCobro(lineas, adelanto + realDeCobro(47.06, true, r1, { bcv: r1.saldoBcv, real: r1.saldoReal }), 15).saldoBcv, 0)
  check('pagar el saldo en divisas lo deja en cero', resumenCobro(lineas, adelanto + realDeCobro(40, false, r1), 15).saldoBcv, 0)
  // Dos métodos al revés: la mitad en efectivo y el saldo BCV que muestra la pantalla, en Bs.
  const r2m = resumenCobro(lineas, realDeCobro(40, false, r0), 15)
  check('mitad en efectivo y el saldo en Bs lo deja en cero',
    resumenCobro(lineas, 40 + realDeCobro(r2m.saldoBcv, true, r2m, { bcv: r2m.saldoBcv, real: r2m.saldoReal }), 15).saldoBcv, 0)
  check('pedido en dólares reales (sin escalón): el monto se guarda tal cual', realDeCobro(47.06, true, resumenCobro(lineas, 0, null)), 47.06)
  check('adelanto del total entero en BCV = total real exacto', realDeCobro(94.12, true, r0, { bcv: 94.12, real: 80 }), 80)

  // Al azar: 50% en Bs (o en divisas) y después el saldo que muestra la pantalla, en Bs.
  // Tiene que quedar en cero exacto en las dos monedas, sin centavos sueltos del redondeo.
  let semilla = 7
  const azar = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647)
  let malos = 0
  for (let i = 0; i < 20000; i++) {
    const esc = 5 * (1 + Math.floor(azar() * 9))
    const ls = Array.from({ length: 1 + Math.floor(azar() * 6) }, () => ({
      salePrice: r2(1 + azar() * 300), quantity: 1 + Math.floor(azar() * 12),
    }))
    const t = resumenCobro(ls, 0, esc)
    const primero = azar() < 0.5
      ? realDeCobro(r2(t.totalBcv / 2), true, t, { bcv: t.totalBcv, real: t.totalReal })
      : realDeCobro(r2(t.totalReal / 2), false, t)
    const m = resumenCobro(ls, primero, esc)
    const fin = resumenCobro(ls, primero + realDeCobro(m.saldoBcv, true, m, { bcv: m.saldoBcv, real: m.saldoReal }), esc)
    if (Math.abs(fin.saldoBcv) > 0.001 || Math.abs(fin.saldoReal) > 0.001) malos++
  }
  check('adelanto + saldo en Bs dejan el pedido en cero (20000 pedidos al azar)', malos, 0)

  // Y sin cobrar nada, el saldo BCV es exactamente el total de la tabla (no unos centavos de más).
  let corridos = 0
  for (let i = 0; i < 20000; i++) {
    const esc = 5 * (1 + Math.floor(azar() * 9))
    const ls = Array.from({ length: 1 + Math.floor(azar() * 6) }, () => ({
      salePrice: r2(1 + azar() * 300), quantity: 1 + Math.floor(azar() * 12),
    }))
    const t = resumenCobro(ls, 0, esc)
    if (Math.abs(t.saldoBcv - t.totalBcv) > 0.001) corridos++
  }
  check('sin cobros, saldo BCV = total BCV de la tabla (20000 pedidos al azar)', corridos, 0)
}

// ── Cuentas y conversión de Bs a USDT ──────────────────────────────────────────────────
console.log('\nCUENTAS Y CONVERSIÓN Bs → USDT')
{
  const si = (b: boolean) => (b ? 1 : 0)
  check('Pago móvil entra al banco en Bs', si(cuentaDeMetodo('Pago móvil / Transferencia Bs') === 'banco_bs'), 1)
  check('Binance / USDT es la cuenta USDT', si(cuentaDeMetodo('Binance / USDT') === 'usdt'), 1)
  check('giro bancario sale de la cuenta en USD', si(cuentaDeMetodo('Giro bancario') === 'banco_usd'), 1)
  check('la tarjeta (Binance Card) sale de USDT', si(cuentaDeMetodo('Tarjeta') === 'usdt'), 1)
  check('sin método no hay cuenta', si(cuentaDeMetodo(null) === null), 1)

  // $47.06 BCV a 106.5 Bs → Bs 5011.89; con otro método no hay Bs.
  const bs = datosBs('Pago móvil / Transferencia Bs', 47.06, 106.5)
  check('Bs de un cobro = monto × tasa', bs?.montoBs ?? -1, 5011.89)
  check('en divisas no hay Bs', si(datosBs('Efectivo USD', 40, 106.5) === null), 1)
  // Un cobro en Bs se escribe en bolívares y tasa; los dólares salen de dividir.
  const BS = 'Pago móvil / Transferencia Bs'
  const form = (campos: Record<string, string>) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(campos)) fd.set(k, v)
    return fd
  }
  const l = leerCobroBs(form({ montoBs: '20000', tasaBs: '103' }), BS)
  check('20000 Bs a 103 = $194.17 (dólares que salen de dividir)', l.ok && l.cobro ? l.cobro.montoUsd : -1, 194.17)
  check('los Bs se guardan tal cual se escribieron', l.ok && l.cobro ? l.cobro.montoBs : -1, 20000)
  check('coma decimal en la tasa', (() => { const r = leerCobroBs(form({ montoBs: '1065', tasaBs: '106,5' }), BS); return r.ok && r.cobro ? r.cobro.montoUsd : -1 })(), 10)
  check('Bs vacíos se rechazan', si(leerCobroBs(form({ montoBs: '', tasaBs: '103' }), BS).ok), 0)
  check('Bs vacíos con "opcional" = todavía no pagó', si(leerCobroBs(form({ montoBs: '', tasaBs: '103' }), BS, true).ok), 1)
  check('tasa vacía se rechaza', si(leerCobroBs(form({ montoBs: '20000', tasaBs: '' }), BS).ok), 0)
  check('tasa en cero se rechaza', si(leerCobroBs(form({ montoBs: '20000', tasaBs: '0' }), BS).ok), 0)
  // Pieza de $15 BCV = 15.003 Bs; le recibió 15.000 como si fueran los $15.
  const eq = leerCobroBs(form({ montoBs: '15000', tasaBs: '1000.2', equivalenteUsd: '15' }), BS)
  check('el equivalente manda sobre la división', eq.ok && eq.cobro ? eq.cobro.montoUsd : -1, 15)
  check('con equivalente los Bs siguen tal cual', eq.ok && eq.cobro ? eq.cobro.montoBs : -1, 15000)
  check('con equivalente la tasa sigue siendo la de referencia', eq.ok && eq.cobro ? eq.cobro.tasaBs : -1, 1000.2)
  check('un equivalente ilegible se rechaza', si(leerCobroBs(form({ montoBs: '15000', tasaBs: '1000.2', equivalenteUsd: 'x' }), BS).ok), 0)
  const divisas = leerCobroBs(form({}), 'Efectivo USD')
  check('en divisas no se lee nada de Bs', si(divisas.ok && divisas.cobro === null), 1)
  check('los Bs exactos mandan sobre monto × tasa', datosBs(BS, 194.17, 103, 20000)?.montoBs ?? -1, 20000)

  // Dos cobros: $40 = Bs 4000 y $60 = Bs 7200 → 100 / 11200 USD por Bs. Uno sin Bs anotados
  // (de antes de que se guardaran) no mueve el promedio.
  const prom = usdPorBsEnCuenta([{ usd: 40, bs: 4000 }, { usd: 60, bs: 7200 }, { usd: 500, bs: 0 }])
  check('promedio ponderado de lo que hay en Bs', Math.round((prom ?? 0) * 1e6) / 1e6, Math.round((100 / 11200) * 1e6) / 1e6)
  check('sin Bs anotados no hay promedio', si(usdPorBsEnCuenta([{ usd: 500, bs: 0 }]) === null), 1)

  // Con devaluación: enero 40.000 Bs = $1000, convertidos en febrero (salen a su valor en libro);
  // octubre 200.000 Bs = $1000. Lo que queda vale $1000, no el promedio de toda la historia ($1667).
  const enero = { usd: 1000, bs: 40000 }
  const salidaFeb = { usd: -40000 * (usdPorBsEnCuenta([enero]) ?? 0), bs: -40000 }
  const oct = { usd: 1000, bs: 200000 }
  const valorOct = usdPorBsEnCuenta([enero, salidaFeb, oct]) ?? 0
  check('devaluación: los Bs de hoy valen lo que entraron hoy', convertir(200000, 990, valorOct).valorLibroUsd, 1000)
  check('devaluación: convertir cuesta lo que costó, no lo que se devaluó antes', convertir(200000, 990, valorOct).costoUsd, 10)
  check('cuenta vacía según lo anotado: sin promedio', si(usdPorBsEnCuenta([enero, salidaFeb]) === null), 1)
  // Quedan $100.03 en Bs 11200 y doy Bs 11250 (unos Bs que no estaban anotados): sale todo lo que
  // hay en dólares, la cuenta queda en $0 y no en −$0.42. Dar una parte sigue usando el promedio.
  const quedan = [{ usd: 100.03, bs: 11200 }]
  check('vaciar la cuenta saca todos sus dólares', convertir(11250, 99, usdPorBsAlConvertir(11250, quedan) ?? 0).valorLibroUsd, 100.03)
  check('dar una parte usa el promedio', convertir(5600, 49, usdPorBsAlConvertir(5600, quedan) ?? 0).valorLibroUsd, 50.02)

  // Doy Bs 11200, que el libro valora en $100, y recibo 92 USDT: costó $8 (8%).
  const c = convertir(11200, 92, 100 / 11200)
  check('valor en libro de los Bs entregados', c.valorLibroUsd, 100)
  check('costo de convertir = valor en libro − USDT recibidos', c.costoUsd, 8)
  check('tasa efectiva en Bs por USDT', Math.round(c.tasaEfectiva * 100) / 100, 121.74)
  check('costo en %', Math.round(c.costoPct * 10) / 10, 8)
  check('recibir más de lo que valían es ganancia (costo negativo)', convertir(11200, 105, 100 / 11200).costoUsd, -5)
  // Efectivo → USDT: un dólar vale un dólar; el costo es lo que quitaron (o dieron a favor).
  check('efectivo: di $100, recibí 97 USDT → costó $3', convertir(100, 97, 1).costoUsd, 3)
  check('efectivo: di $100, recibí 101 USDT → a favor $1', convertir(100, 101, 1).costoUsd, -1)
  // La caja baja exactamente el costo: sale `valor`, entra `usdt`.
  check('la caja baja lo que costó convertir', Math.round((c.usdt - c.valorLibroUsd) * 100) / 100, -c.costoUsd)
}

// ── Venta del depósito: stock, costo congelado y margen ─────────────────────────────────
console.log('\nVENTA DEL DEPÓSITO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const piezas = [
    { id: 1, stock: 5, nameEs: 'Pastillas', bajajCode: 'P1' },
    { id: 2, stock: 1, nameEs: 'Filtro', bajajCode: null },
  ]
  const ok1 = { productId: 1, quantity: 2, salePrice: 12, costoUnitUsd: 7.5 }
  check('una venta con stock y costo se puede hacer', si(motivoNoVendible([ok1], piezas) === null), 1)
  check('más de lo que hay en el depósito se rechaza', si(motivoNoVendible([{ ...ok1, quantity: 6 }], piezas) !== null), 1)
  check('justo lo que hay se puede vender', si(motivoNoVendible([{ ...ok1, quantity: 5 }], piezas) === null), 1)
  check('sin costo no se vende (vacío no es cero)', si(motivoNoVendible([{ ...ok1, costoUnitUsd: 0 }], piezas) !== null), 1)
  check('costo ilegible se rechaza', si(motivoNoVendible([{ ...ok1, costoUnitUsd: NaN }], piezas) !== null), 1)
  check('la misma pieza dos veces se rechaza', si(motivoNoVendible([ok1, ok1], piezas) !== null), 1)
  check('una pieza que ya no existe se rechaza', si(motivoNoVendible([{ ...ok1, productId: 99 }], piezas) !== null), 1)
  check('cantidad con decimales se rechaza', si(motivoNoVendible([{ ...ok1, quantity: 1.5 }], piezas) !== null), 1)
  check('venta vacía se rechaza', si(motivoNoVendible([], piezas) !== null), 1)

  check('costo de la línea = unitario × cantidad, al centavo', costoDeLinea(7.333, 3), 22)
  const r = resumenVenta([ok1, { productId: 2, quantity: 1, salePrice: 20, costoUnitUsd: 13 }])
  check('venta total', r.ventaUsd, 44)
  check('costo total', r.costoUsd, 28)
  check('margen en dólares', r.margenUsd, 16)
  check('margen sobre el precio de venta', Math.round(r.margenPct * 100) / 100, 36.36)
}

// ── Reparto del aéreo en una caja sin pesar: sin volado en la frontera peso/volumen ─────────
console.log('\nREPARTO DEL AÉREO EN UNA CAJA SIN PESAR')
{
  const pieza = (id: number, gramos: number, l: number, a: number, h: number): EnvioItemInput => ({
    pedidoId: id, productId: id, name: `P${id}`, weightGrams: gramos, dimL: l, dimA: a, dimH: h,
    priceInr: 1000, quantity: 1, origen: 'india', inbound: 'shoppre', supplierId: null,
  })
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  // Una pieza densa (8 kg, 1.6 kg volumétricos) y una voluminosa y liviana (0.5 kg real).
  const denso = pieza(1, 8000, 20, 20, 20)
  // Volumétrico del conjunto: justo 3% por encima del real (8.5 kg).
  const casi = calcEnvio([denso, pieza(2, 500, 35, 33, 31)], cfg)
  const aire = casi.lines.reduce((s, l) => s + l.airUsd, 0)
  check('la suma del reparto es el costo del tramo (nada se pierde ni se inventa)', r3(aire), r3(casi.air.costUsd))
  check('ata el volumen por 3%: el reparto es una mezcla, no todo volumen', r3(casi.air.repartoVolumen ?? -1), r3((casi.air.volKg / casi.air.realKg - 1) / 0.1))

  // Continuidad: se barre la altura de la pieza voluminosa de 29 a 30.5 cm (el volumétrico cruza
  // al real hacia los 29.5) de a una centésima. La parte que carga la voluminosa tiene que
  // moverse de a poco; con el reparto todo-o-nada daba un salto de ~0.75 en un solo paso.
  const parte = (h: number) => {
    const c = calcEnvio([denso, pieza(2, 500, 35, 33, h)], cfg)
    return { parte: c.lines[1].airUsd / c.air.costUsd, volumen: c.air.repartoVolumen ?? -1 }
  }
  let salto = 0
  let previo = parte(29)
  for (let h = 29.01; h <= 30.5; h += 0.01) {
    const ahora = parte(h)
    salto = Math.max(salto, Math.abs(ahora.parte - previo.parte))
    previo = ahora
  }
  check('barrido por la frontera peso/volumen: el mayor salto entre pasos es < 0.01 (era ~0.75)', salto < 0.01 ? 1 : 0, 1)

  const debajo = calcEnvio([denso, pieza(2, 500, 35, 33, 29)], cfg)   // volumétrico 8.30 < real 8.50: ata el peso
  check('atada por peso: todo se reparte por peso', debajo.air.repartoVolumen ?? -1, 0)
  check('…y la voluminosa carga solo su parte de peso', Math.abs(debajo.lines[1].airUsd / debajo.air.costUsd - 0.5 / 8.5) < 1e-9 ? 1 : 0, 1)
  const lejos = calcEnvio([denso, pieza(2, 500, 60, 50, 40)], cfg)  // volumétrico 3x el real
  check('muy por encima de la banda: todo por volumen', lejos.air.repartoVolumen ?? -1, 1)
  const volShare = lejos.lines[1].volKg / (lejos.lines[0].volKg + lejos.lines[1].volKg)
  check('…y la voluminosa carga su parte de volumen', Math.abs(lejos.lines[1].airUsd / lejos.air.costUsd - volShare) < 1e-9 ? 1 : 0, 1)

  // La voluminosa cuesta MENOS en la caja que apenas ata por volumen que si se repartiera
  // todo por volumen (que es lo que daba un −$23 por un 3% de diferencia).
  const todoVolumen = casi.lines[1].volKg / (casi.lines[0].volKg + casi.lines[1].volKg)
  check('la voluminosa paga menos que con el reparto todo-por-volumen', casi.lines[1].airUsd / casi.air.costUsd < todoVolumen ? 1 : 0, 1)

  // Con la caja pesada y medida vale la regla exacta, aunque la diferencia sea de 0.5%.
  const medida = calcEnvio([denso, pieza(2, 500, 35, 33, 31)], cfg, { medidas: { pesoKg: 8.6, dimL: 40, dimA: 40, dimH: 27 } })
  check('caja pesada y medida: ata el volumen por un pelo y se reparte entero por volumen', medida.air.repartoVolumen ?? -1, 1)
}

// ── Margen realizado ────────────────────────────────────────────────────────────────────
console.log('\nMARGEN REALIZADO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const en = (d: string) => new Date(d)
  const linea = (venta: number, costo: number | null, real = true, entregada = true, at = '2026-10-10T15:00:00Z'): LineaMargen =>
    ({ ventaUsd: venta, costoUsd: costo, costoReal: real, entregada, entregadaAt: entregada ? en(at) : null })

  const a = margenDePedido([linea(80, 52), linea(20, 14)])
  check('venta = suma de las líneas', a.ventaUsd, 100)
  check('costo = suma de las líneas', a.costoUsd, 66)
  check('margen = venta − costo', a.margenUsd ?? -1, 34)
  check('margen % sobre la venta', Math.round((a.margenPct ?? 0) * 10) / 10, 34)
  check('entregado y todo real = realizado', si(a.estado === 'realizado'), 1)
  check('entregado con un costo estimado = estimado', si(margenDePedido([linea(80, 52), linea(20, 14, false)]).estado === 'estimado'), 1)
  check('una línea sin entregar = en curso (proyección)', si(margenDePedido([linea(80, 52), linea(20, 14, true, false)]).estado === 'en_curso'), 1)
  const sc = margenDePedido([linea(80, 52), linea(20, null)])
  check('una línea sin costo: no hay margen (no se inventa)', si(sc.margenUsd === null), 1)
  check('una línea sin costo = sin_costo', si(sc.estado === 'sin_costo'), 1)
  check('el costo conocido sigue sumando (es un piso)', sc.costoUsd, 52)
  check('pérdida: el margen sale negativo', margenDePedido([linea(45, 68.32)]).margenUsd ?? 0, -23.32)
  check('se entregó cuando se entregó la última línea', margenDePedido([linea(10, 5, true, true, '2026-10-02T12:00:00Z'), linea(10, 5, true, true, '2026-10-20T12:00:00Z')]).entregadoAt?.toISOString().slice(0, 10) === '2026-10-20' ? 1 : 0, 1)

  // El mes se corta en hora de Venezuela (UTC−4): la noche del 31 sigue siendo octubre.
  check('01:00 UTC del 1 de noviembre es todavía 31 de octubre en Caracas', si(mesDe(en('2026-11-01T01:00:00Z')) === '2026-10'), 1)
  check('04:00 UTC del 1 de noviembre ya es noviembre', si(mesDe(en('2026-11-01T04:00:00Z')) === '2026-11'), 1)

  const P = (m: MargenPedido, f: string) => ({ margen: m, fecha: en(f) })
  const meses = resultadoPorMes(
    [
      P(a, '2026-10-10T15:00:00Z'),
      P(margenDePedido([linea(50, 30, false)]), '2026-10-12T15:00:00Z'),
      P(sc, '2026-10-15T15:00:00Z'),
      P(margenDePedido([linea(200, 100, true, false)]), '2026-10-16T15:00:00Z'),
      P(margenDePedido([linea(60, 40)]), '2026-09-20T15:00:00Z'),
    ],
    [
      { fecha: en('2026-10-05T16:00:00Z'), categoria: 'gasto_operativo', monto: 25 },
      { fecha: en('2026-10-06T16:00:00Z'), categoria: 'otro_egreso', monto: 5 },
      { fecha: en('2026-10-07T16:00:00Z'), categoria: 'flete_aereo', monto: 612 },
      { fecha: en('2026-10-07T16:00:00Z'), categoria: 'comision_giro', monto: 9 },
      { fecha: en('2026-10-07T16:00:00Z'), categoria: 'pago_proveedor', monto: 300 },
      { fecha: en('2026-10-08T16:00:00Z'), categoria: 'conversion_salida', monto: 100 },
      { fecha: en('2026-10-08T16:00:00Z'), categoria: 'conversion_entrada', monto: 92 },
    ],
  )
  const oct = meses.find(m => m.mes === '2026-10')!
  check('octubre: cuenta lo realizado y lo estimado, no lo en curso ni lo sin costo', oct.pedidos, 2)
  check('octubre: vendido', oct.ventaUsd, 150)
  check('octubre: margen', oct.margenUsd, 54)
  check('octubre: la parte estimada del margen', oct.margenEstimadoUsd, 20)
  check('octubre: el entregado sin costo se avisa, no suma', oct.pedidosSinCosto, 1)
  check('octubre: gastos = operativo + otros (flete, giro y compra ya están en el costo)', oct.gastosUsd, 30)
  check('octubre: costo de convertir Bs = salida − entrada', oct.conversionUsd, 8)
  check('octubre: resultado = margen − gastos − convertir', oct.resultadoUsd, 16)
  check('septiembre aparece aparte', meses.find(m => m.mes === '2026-09')?.margenUsd ?? -1, 20)
  check('más reciente primero', si(meses[0].mes === '2026-10'), 1)
}

// ── Stock de un conjunto: entra como sus piezas ─────────────────────────────────────────
console.log('\nSTOCK DE UN CONJUNTO (entrega de stock propio)')
{
  const resolver = construirResolver([
    { id: 1, bajajCode: 'A1', nameEs: 'Rodamiento' },
    { id: 2, bajajCode: 'B2', nameEs: 'Retén' },
    { id: 3, bajajCode: null, nameEs: 'Tornillo' },
    // Código repetido en dos filas: no se elige ninguna.
    { id: 4, bajajCode: 'DUP', nameEs: 'Pieza X' },
    { id: 5, bajajCode: 'DUP', nameEs: 'Pieza Y' },
  ])
  const pieza = (bajajCode: string | null, nameEs: string, quantity: number) => ({ bajajCode, nameEs, quantity, groupName: 'g' })

  // 2 sets; el rodamiento aparece en dos subgrupos (1 + 2 por set): 6 unidades en una sola fila.
  const r = piezasDeLinea({
    productId: null, quantity: 2,
    bundleItems: [pieza('A1', 'Rodamiento', 1), pieza('A1', 'Rodamiento', 2), pieza('B2', 'Retén', 1), pieza(null, 'Tornillo', 4)],
  }, resolver)
  const de = (id: number) => r.piezas.find(p => p.productId === id)?.unidades ?? 0
  check('rodamiento: (1 + 2) × 2 sets, sumado por producto', de(1), 6)
  check('retén: 1 × 2', de(2), 2)
  check('sin código, por nombre único: 4 × 2', de(3), 8)
  check('una fila por producto', r.piezas.length, 3)
  check('nada sin resolver', r.faltan.length, 0)

  const dup = piezasDeLinea({ productId: null, quantity: 1, bundleItems: [pieza('DUP', 'Pieza X', 1), pieza('ZZZ', '?', 1)] }, resolver)
  check('código repetido o inexistente: no se adivina', dup.faltan.length, 2)
  check('…y no suma nada', dup.piezas.length, 0)

  const suelta = piezasDeLinea({ productId: 9, quantity: 3, bundleItems: null }, resolver)
  check('pieza suelta: su producto y su cantidad', suelta.piezas[0]?.unidades ?? 0, 3)
}

// ── Flujos fuera del camino feliz (docs/REVISION-NEGOCIO.md, punto 2) ───────────────────────
console.log('\nVALIDEZ DEL PRESUPUESTO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const cotizado = new Date('2026-10-01T15:00:00Z') // 11:00 en Venezuela
  const e = estadoValidez({ cotizadoAt: cotizado, createdAt: new Date('2026-09-01T00:00:00Z') }, 7, new Date('2026-10-08T20:00:00Z'))
  check('vale todo el día 7 (hora de Venezuela), no hasta las 11:00', si(e.venceEl.toISOString() === '2026-10-09T03:59:59.999Z'), 1)
  check('el último día todavía vale', si(e.vencido), 0)
  check('…y dice que vence hoy', e.diasRestantes, 0)
  const pasado = estadoValidez({ cotizadoAt: cotizado, createdAt: cotizado }, 7, new Date('2026-10-09T04:00:00Z'))
  check('un instante después del último día venció', si(pasado.vencido), 1)
  const viejo = estadoValidez({ cotizadoAt: null, createdAt: new Date('2026-08-01T12:00:00Z') }, 7, new Date('2026-10-13T12:00:00Z'))
  check('un presupuesto anterior (sin cotizadoAt) cuenta desde que se creó', si(viejo.vencido), 1)
  check('validezDias: vacío cae a 7', validezDias({}), 7)
  check('validezDias: 0 cae a 7 (vencería todo al emitirlo)', validezDias({ presupuesto_validez_dias: '0' }), 7)
  check('validezDias: ilegible cae a 7', validezDias({ presupuesto_validez_dias: 'abc' }), 7)
  check('validezDias: 10', validezDias({ presupuesto_validez_dias: '10' }), 10)
  check('el escalón de la cotización gana al de hoy', escalonDelPresupuesto(15, 20) ?? -1, 15)
  check('sin escalón guardado se usa el de hoy', escalonDelPresupuesto(null, 20) ?? -1, 20)
  check('sin ninguno, ninguno', si(escalonDelPresupuesto(null, null) === null), 1)
  check('vencido no se aprueba', si(motivoNoAprobable(pasado) != null), 1)
  check('vigente sí', si(motivoNoAprobable(e) != null), 0)
}

console.log('\nEDITAR UN PEDIDO CONFIRMADO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const act = (over: Partial<LineaActual> & { id: number; productId: number }): LineaActual => ({
    ensambleId: null, quantity: 5, salePrice: 20, bundleItems: null, shippingStatus: 'pendiente', costRealUsd: null, nombre: `P${over.productId}`, ...over,
  })
  const nue = (productId: number, quantity: number, salePrice = 20, bundleItems: unknown = null): LineaNueva => ({
    productId, ensambleId: null, quantity, salePrice, bundleItems,
  })
  check('pendiente sin costo = libre', si(estadoLinea({ shippingStatus: 'pendiente', costRealUsd: null }) === 'libre'), 1)
  check('pendiente con costo real = comprada', si(estadoLinea({ shippingStatus: 'pendiente', costRealUsd: 10 }) === 'comprada'), 1)
  check('en camino sin costo cargado = comprada', si(estadoLinea({ shippingStatus: 'camino_usa', costRealUsd: null }) === 'comprada'), 1)
  check('entregado = entregada', si(estadoLinea({ shippingStatus: 'entregado', costRealUsd: 10 }) === 'entregada'), 1)

  const libre = planEdicion([act({ id: 1, productId: 1 })], [nue(1, 3)])
  check('libre: cambiar la cantidad se aplica', si(libre.ops[0]?.op === 'actualizar'), 1)
  check('libre: sin cambios no hace nada', planEdicion([act({ id: 1, productId: 1 })], [nue(1, 5)]).ops.length, 0)
  check('libre: sacarla la quita', si(planEdicion([act({ id: 1, productId: 1 })], []).ops[0]?.op === 'quitar'), 1)
  check('agregar una pieza nueva la crea', si(planEdicion([act({ id: 1, productId: 1 })], [nue(1, 5), nue(2, 1)]).ops.some(o => o.op === 'crear')), 1)

  const comprada = act({ id: 2, productId: 2, shippingStatus: 'camino_usa', costRealUsd: 100 })
  const baja = planEdicion([comprada], [nue(2, 3)]).ops[0]
  check('comprada: bajar la cantidad manda las de más a stock', si(baja?.op === 'sobrante' && baja.unidades === 2 && baja.nueva?.quantity === 3), 1)
  const quita = planEdicion([comprada], [nue(9, 1)]).ops.find(o => o.op === 'sobrante')
  check('comprada: sacarla manda TODAS a stock, nada se pierde', si(quita?.op === 'sobrante' && quita.unidades === 5 && quita.nueva === null), 1)
  check('comprada: subir la cantidad se rechaza', si(planEdicion([comprada], [nue(2, 6)]).error != null), 1)
  check('comprada: cambiar solo el precio es solo el precio', si(planEdicion([comprada], [nue(2, 5, 25)]).ops[0]?.op === 'precio'), 1)
  check('comprada: cambiar el conjunto se rechaza', si(planEdicion(
    [act({ ...comprada, id: 3, productId: 3, bundleItems: [{ nameEs: 'a', quantity: 1 }] })],
    [nue(3, 5, 20, [{ nameEs: 'a', quantity: 2 }])],
  ).error != null), 1)
  check('comprada: el mismo conjunto en otro orden de claves no cuenta como cambio', planEdicion(
    [act({ ...comprada, id: 3, productId: 3, bundleItems: [{ nameEs: 'a', quantity: 1 }] })],
    [nue(3, 5, 20, [{ quantity: 1, nameEs: 'a' }])],
  ).ops.length, 0)

  const entregada = act({ id: 4, productId: 4, shippingStatus: 'entregado', costRealUsd: 50 })
  check('entregada: tal cual no hace nada', planEdicion([entregada], [nue(4, 5)]).ops.length, 0)
  check('entregada: cambiarla se rechaza', si(planEdicion([entregada], [nue(4, 4)]).error != null), 1)
  check('entregada: sacarla se rechaza', si(planEdicion([entregada], []).error != null), 1)

  // El costo de lo que pasa a stock viaja con las unidades y lo que queda es el resto EXACTO.
  const r = repartirSobrante(100, 3, 1)
  check('sobrante: el costo de 1 de 3', r.sobranteUsd ?? -1, 33.33)
  check('sobrante: lo que queda es el resto exacto', r.quedaUsd ?? -1, 66.67)
  let desvio = 0
  for (const [costo, cant, uds] of [[100, 3, 1], [99.99, 7, 3], [0.05, 9, 4], [1234.56, 11, 10]] as const) {
    const x = repartirSobrante(costo, cant, uds)
    desvio += Math.abs((x.sobranteUsd ?? 0) + (x.quedaUsd ?? 0) - costo)
  }
  check('sobrante: nunca se pierde ni sobra un centavo', desvio, 0, 1e-9)
  check('sobrante: sin costo cargado no se inventa', si(repartirSobrante(null, 3, 1).sobranteUsd === null), 1)
  check('el historial dice qué pasó', si(describirOps(planEdicion([comprada], [nue(2, 3)]).ops)[0]?.includes('stock propio') ?? false), 1)

  // Stock propio / presupuesto: lo comprado no tiene adónde ir, así que queda fijo salvo el precio.
  check('sin cliente: quitar una comprada se rechaza', si(motivoEdicionSinCliente([comprada], []) != null), 1)
  check('sin cliente: bajarle unidades se rechaza', si(motivoEdicionSinCliente([comprada], [nue(2, 3)]) != null), 1)
  check('sin cliente: cambiarle el precio vale', si(motivoEdicionSinCliente([comprada], [nue(2, 5, 25)]) == null), 1)
  check('sin cliente: lo libre y lo entregado se editan', si(motivoEdicionSinCliente(
    [act({ id: 1, productId: 1 }), entregada], [nue(1, 2)],
  ) == null), 1)
}

console.log('\nCANCELAR UN PEDIDO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const base = { tipo: 'cliente', status: 'pedido', items: [{ shippingStatus: 'pendiente', costRealUsd: null }] }
  check('un pedido de cliente confirmado se cancela', si(motivoNoCancelable(base) != null), 0)
  check('un presupuesto no se cancela, se borra', si(motivoNoCancelable({ ...base, status: 'presupuesto' }) != null), 1)
  check('uno ya cancelado no', si(motivoNoCancelable({ ...base, status: 'cancelado' }) != null), 1)
  check('stock propio no', si(motivoNoCancelable({ ...base, tipo: 'propio' }) != null), 1)
  check('con algo ya entregado no se cancela entero', si(motivoNoCancelable({ ...base, items: [{ shippingStatus: 'entregado', costRealUsd: 5 }] }) != null), 1)
  const mixto = resumenCancelacion([
    { shippingStatus: 'pendiente', costRealUsd: null }, { shippingStatus: 'camino_usa', costRealUsd: 40 }, { shippingStatus: 'pendiente', costRealUsd: 10 },
  ])
  check('cuenta lo comprado (aunque siga pendiente con costo)', mixto.compradas, 2)
  check('y lo que nunca se compró', mixto.libres, 1)
  check('sin nada comprado se propone devolver todo', devolucionSugerida(100, { compradas: 0, libres: 2 }), 100)
  check('con algo comprado, nada (los términos: no se reembolsa)', devolucionSugerida(100, mixto), 0)
  check('no se devuelve más de lo cobrado', si(motivoDevolucionInvalida(150, 100) != null), 1)
  check('devolver todo lo cobrado sí', si(motivoDevolucionInvalida(100, 100) != null), 0)
  check('un monto negativo no', si(motivoDevolucionInvalida(-1, 100) != null), 1)
  check('un cancelado no se puede borrar', si(motivoNoEliminable({ tipo: 'cliente', status: 'cancelado', depositUsd: null, movimientos: 0, items: [] }) != null), 1)
}

console.log('\nINCIDENCIAS Y RECLAMOS')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const libre = { shippingStatus: 'pendiente', costRealUsd: null }
  const enCamino = { shippingStatus: 'en_venezuela', costRealUsd: 100 }
  const entregada = { shippingStatus: 'entregado', costRealUsd: 100 }
  check('sin comprar solo puede no estar disponible', si(tiposPara(libre).join() === 'no_disponible'), 1)
  check('en camino: lo que le pasa a la mercancía', tiposPara(enCamino).length, 4)
  check('entregada: solo reclamos, y el defecto de fábrica se admite', si(tiposPara(entregada).includes('defecto') && !tiposPara(entregada).includes('perdida')), 1)
  check('lo de una línea entregada es un reclamo del cliente', si(origenPara(entregada) === 'cliente'), 1)
  check('lo de una en camino lo detecté yo', si(origenPara(enCamino) === 'operacion'), 1)
  check('un reclamo del cliente puede no proceder', si(resolucionesPara('danada', 'cliente').includes('rechazado')), 1)
  check('lo que detecto yo no se "rechaza"', si(resolucionesPara('danada', 'operacion').includes('rechazado')), 0)
  check('un no disponible se cierra cambiándolo', si(resolucionesPara('no_disponible', 'operacion').includes('sustituida')), 1)

  // Un conjunto casi nunca falla entero: falta UN SKU, y quitarlo al editar cierra solo ese problema.
  const disco = { nameEs: 'Disco', bajajCode: 'JA1' }
  const resorte = { nameEs: 'Resorte', bajajCode: null }
  const abiertasConj = [
    { id: 1, tipo: 'no_disponible', pieza: etiquetaPieza(disco) },
    { id: 2, tipo: 'no_disponible', pieza: etiquetaPieza(resorte) },
    { id: 3, tipo: 'no_disponible', pieza: null },
    { id: 4, tipo: 'danada', pieza: etiquetaPieza(disco) },
  ]
  check('la pieza se nombra con su código', si(etiquetaPieza(disco) === 'Disco (JA1)' && etiquetaPieza(resorte) === 'Resorte'), 1)
  check('quitar solo el SKU que falta cierra solo esa incidencia', si(cerradosPorEdicion(abiertasConj, [resorte]).join() === '1'), 1)
  check('quitar otra pieza no cierra nada', cerradosPorEdicion(abiertasConj, [disco, resorte]).length, 0)
  check('si la pieza sigue en el conjunto, sigue frenando la compra', si(cerradosPorEdicion(abiertasConj, [disco]).includes(1)), 0)
  check('lo de la línea entera no se cierra al cambiar el conjunto', si(cerradosPorEdicion(abiertasConj, []).includes(3)), 0)
  check('solo un "no disponible" se cierra por quitarlo', si(cerradosPorEdicion(abiertasConj, []).includes(4)), 0)

  check('algo abierto frena la entrega', si(bloqueaEntrega([{ tipo: 'faltante', estado: 'abierta' }])), 1)
  check('algo ya resuelto no', si(bloqueaEntrega([{ tipo: 'faltante', estado: 'resuelta' }])), 0)
  check('un no disponible abierto frena la compra', si(bloqueaCompra([{ tipo: 'no_disponible', estado: 'abierta' }])), 1)
  check('una dañada abierta no frena una compra', si(bloqueaCompra([{ tipo: 'danada', estado: 'abierta' }])), 0)

  check('pérdida sugerida: 2 de 5 de $100', perdidaSugerida(100, 5, 2), 40)
  const linea = { quantity: 5, salePrice: 20, costRealUsd: 100 }
  const p = planReembolso(linea, 2, 40)
  check('reembolsar 2 de 5: quedan 3', p.quedan, 3)
  check('…la línea conserva el costo de las 3 que quedan', p.costRealNuevo ?? -1, 60)
  check('…y baja lo vendido 2 × $20', p.bajaVentaUsd, 40)
  check('…el costo de la línea más la pérdida es lo que se pagó', (p.costRealNuevo ?? 0) + p.perdidaUsd, 100)
  check('reembolsar las 5 quita la línea', si(planReembolso(linea, 5, 100).quitaLinea), 1)
  check('…y el costo entero queda como pérdida del pedido', planReembolso(linea, 5, 100).perdidaUsd, 100)
  check('línea sin costo cargado: no hay costo que sacar', si(planReembolso({ ...linea, costRealUsd: null }, 2, 0).costRealNuevo === null), 1)

  const res = (resolucion: Resolucion, cantidad = 2, over: object = {}) => motivoResolucionInvalida({
    tipo: 'danada', origen: 'operacion', cantidad, resolucion, linea, perdidaUsd: null, ...over,
  })
  check('reponer 2 de 5 es válido', si(res('reposicion') != null), 0)
  check('reembolsar más de lo que tiene la línea no', si(res('reembolso', 6) != null), 1)
  check('"no procede" no aplica a algo que detecté yo', si(res('rechazado') != null), 1)
  check('reponer sin línea no se puede (ya no está)', si(res('reposicion', 2, { linea: null }) != null), 1)
  check('una pérdida negativa no', si(res('reembolso', 2, { perdidaUsd: -5 }) != null), 1)

  const entregadoAt = new Date('2026-10-01T12:00:00Z')
  check('reclamo a las 47 h: dentro del plazo', si(dentroDePlazo(entregadoAt, 48, new Date('2026-10-03T11:00:00Z'))), 1)
  check('a las 49 h: fuera', si(dentroDePlazo(entregadoAt, 48, new Date('2026-10-03T13:00:00Z'))), 0)
  check('sin fecha de entrega no se puede decir que se pasó', si(dentroDePlazo(null, 48)), 1)
}

console.log('\nMARGEN CON PÉRDIDAS Y CANCELACIONES')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const linea: LineaMargen = { ventaUsd: 100, costoUsd: 60, costoReal: true, entregada: true, entregadaAt: new Date('2026-10-10T12:00:00Z') }
  const sin = margenDePedido([linea])
  const con = margenDePedido([linea], { perdidasUsd: 25, ultimaAt: new Date('2026-10-11T12:00:00Z') })
  check('sin pérdidas: margen 40', sin.margenUsd ?? -1, 40)
  check('una pérdida de $25 es costo del pedido', con.costoUsd, 85)
  check('…y baja el margen a 15', con.margenUsd ?? -1, 15)
  check('…y se informa aparte', con.perdidasUsd, 25)
  const vacio = margenDePedido([], { perdidasUsd: 30, ultimaAt: new Date('2026-10-11T12:00:00Z') })
  check('un pedido reembolsado entero termina en pérdida', vacio.margenUsd ?? 0, -30)
  check('…y está cerrado (no queda "en curso" para siempre)', si(vacio.estado !== 'en_curso'), 1)
  check('…en la fecha de la pérdida', si(vacio.entregadoAt?.toISOString() === '2026-10-11T12:00:00.000Z'), 1)
  check('sin líneas ni pérdidas no inventa nada', si(margenDePedido([]).estado === 'en_curso'), 1)

  const meses = resultadoPorMes(
    [{ margen: sin, fecha: new Date('2026-10-10T16:00:00Z') }],
    [{ fecha: new Date('2026-10-11T16:00:00Z'), categoria: 'gasto_operativo', monto: 10 }],
    [{ fecha: new Date('2026-10-12T16:00:00Z'), retenidoUsd: 45 }, { fecha: new Date('2026-11-02T16:00:00Z'), retenidoUsd: 5 }],
  )
  const oct = meses.find(m => m.mes === '2026-10')!
  check('lo que se quedó de un cancelado suma al mes en que se canceló', oct.cancelacionesUsd, 45)
  check('resultado = margen + cancelados − gastos', oct.resultadoUsd, 75)
  check('un mes con solo cancelaciones aparece', meses.find(m => m.mes === '2026-11')?.resultadoUsd ?? -1, 5)
}

console.log('\nENTREGAR CONTRA EL SALDO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  check('saldo = total − cobrado', saldoReal([{ salePrice: 50, quantity: 2 }], 60), 40)
  check('sin cobrar nada, todo el total', saldoReal([{ salePrice: 50, quantity: 2 }], null), 100)
  check('cobrado de más = saldo a favor (negativo)', saldoReal([{ salePrice: 50, quantity: 1 }], 70), -20)
  check('un centavo de redondeo no es deuda', si(debeSaldo(0.01)), 0)
  check('dos centavos sí', si(debeSaldo(0.02)), 1)
  check('todo entregado = entregado sin pagar', si(situacionDeCobro([{ shippingStatus: 'entregado' }, { shippingStatus: 'entregado' }]) === 'entregado'), 1)
  check('algo entregado = parcial', si(situacionDeCobro([{ shippingStatus: 'entregado' }, { shippingStatus: 'camino_usa' }]) === 'parcial'), 1)
  check('nada entregado = en tránsito (lo normal)', si(situacionDeCobro([{ shippingStatus: 'camino_usa' }]) === 'en_transito'), 1)
  check('lo de un cliente se entrega desde su pedido', si(seEntregaDesdeElPedido('cliente')), 1)
  check('el stock propio se cierra en la caja', si(seEntregaDesdeElPedido('propio')), 0)
  check('recibida y sin problemas: se entrega', si(motivoNoEntregable({ shippingStatus: 'en_venezuela', incidencias: [] }) === null), 1)
  check('en camino no se entrega', si(motivoNoEntregable({ shippingStatus: 'camino_venezuela', incidencias: [] }) === null), 0)
  check('con un problema abierto no se entrega', si(motivoNoEntregable({ shippingStatus: 'en_venezuela', incidencias: [{ tipo: 'danada', estado: 'abierta' }] }) === null), 0)
  check('un problema ya resuelto no frena', si(motivoNoEntregable({ shippingStatus: 'en_venezuela', incidencias: [{ tipo: 'danada', estado: 'resuelta' }] }) === null), 1)
}

console.log('\nTIEMPOS REALES POR ETAPA')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const d = (n: number) => new Date(Date.UTC(2026, 9, 1 + n))
  const ev = (itemId: number, desde: string, hacia: string, dia: number) => ({ itemId, desde, hacia, at: d(dia) })
  const eventos = [
    ev(1, 'pendiente', 'camino_shoppre', 0), ev(1, 'camino_shoppre', 'en_shoppre', 3), ev(1, 'en_shoppre', 'camino_usa', 5),
    ev(2, 'pendiente', 'camino_shoppre', 0), ev(2, 'camino_shoppre', 'en_shoppre', 5),
  ]
  const tramos = tiemposPorTramo(eventos)
  const t = tramos.find(x => x.tramo === 'camino_shoppre→en_shoppre')!
  check('un tramo recorrido por dos líneas: n', t.n, 2)
  check('…promedio de 3 y 5 días', t.promedioDias, 4)
  check('…el otro tramo, 2 días', tramos.find(x => x.tramo === 'en_shoppre→camino_usa')?.medianaDias ?? -1, 2)
  check('en el orden del recorrido', si(tramos[0].tramo === 'camino_shoppre→en_shoppre'), 1)
  const total = tiempoDeCompraA(eventos, 'en_shoppre')!
  check('de comprado a llegar a Shoppre: promedio', total.promedioDias, 4)
  check('…mínimo', total.minDias, 3)
  check('una línea que no llegó no cuenta', total.n, 2)
  check('sin llegadas no hay estadística', si(tiempoDeCompraA([ev(1, 'pendiente', 'camino_shoppre', 0)], 'en_venezuela') === null), 1)
  // Un retroceso (se corrigió un error) no es un tramo.
  const retro = tiemposPorTramo([ev(3, 'pendiente', 'camino_usa', 0), ev(3, 'camino_usa', 'en_usa', 2), ev(3, 'en_usa', 'camino_usa', 3)])
  check('un retroceso no cuenta como tramo', retro.length, 1)
  // Un hueco en la cadena (falta un cambio) no se mide como si fuera continuo.
  const hueco = tiemposPorTramo([ev(4, 'pendiente', 'camino_usa', 0), ev(4, 'en_usa', 'camino_venezuela', 9)])
  check('con un hueco en el historial no se inventa el tramo', hueco.length, 0)
}

console.log('\nDEVOLUCIÓN AL CLIENTE (lo que se lee del formulario)')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
  const vacio = leerDevolucion(fd({}))
  check('vacío = no se devuelve nada', si(vacio.ok && vacio.devolucion === null), 1)
  const cero = leerDevolucion(fd({ devolverUsd: '0' }))
  check('0 = no se devuelve nada', si(cero.ok && cero.devolucion === null), 1)
  check('un texto ilegible se rechaza, no se toma por vacío', si(!leerDevolucion(fd({ devolverUsd: 'abc' })).ok), 1)
  const efectivo = leerDevolucion(fd({ devolverUsd: '25.5', devolverMetodo: 'Efectivo USD' }))
  check('en efectivo: monto', efectivo.ok && efectivo.devolucion ? efectivo.devolucion.monto : -1, 25.5)
  check('…sin Bs', si(efectivo.ok && efectivo.devolucion?.bs === null), 1)
  check('sin método no se devuelve', si(!leerDevolucion(fd({ devolverUsd: '10' })).ok), 1)
  check('en Bs piden los bolívares', si(!leerDevolucion(fd({ devolverUsd: '10', devolverMetodo: 'Pago móvil / Transferencia Bs' })).ok), 1)
  const enBs = leerDevolucion(fd({ devolverUsd: '10', devolverMetodo: 'Pago móvil / Transferencia Bs', devolverBs: '1000' }))
  check('en Bs se anotan los entregados tal cual', enBs.ok && enBs.devolucion?.bs ? enBs.devolucion.bs.montoBs : -1, 1000)
  check('…y la tasa sale de Bs ÷ dólares, no se pide', enBs.ok && enBs.devolucion?.bs ? enBs.devolucion.bs.tasaBs : -1, 100)
}

console.log('\nEMBUDO DE PRESUPUESTOS')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const ahora = new Date('2026-10-20T15:00:00Z')
  const hace = (d: number) => new Date(ahora.getTime() - d * 24 * 3600 * 1000)
  const p = (status: string, dias: number, perdido = false) =>
    ({ status, createdAt: hace(dias), cotizadoAt: null, perdidoAt: perdido ? hace(1) : null })
  const e = embudo([p('pedido', 20), p('cancelado', 20), p('presupuesto', 20, true), p('presupuesto', 20), p('presupuesto', 2)], 7, ahora)
  check('confirmados (un cancelado también se había confirmado)', e.confirmados, 2)
  check('perdidos', e.perdidos, 1)
  check('vencidos sin respuesta', e.vencidos, 1)
  check('abiertos', e.abiertos, 1)
  check('conversión sobre los decididos: 2 de 4', e.conversionPct ?? -1, 50)
  check('un perdido todavía vigente cuenta como perdido', si(cierreDe(p('presupuesto', 1, true), 7, ahora) === 'perdido'), 1)
  check('sin decididos no hay conversión', si(embudo([p('presupuesto', 1)], 7, ahora).conversionPct === null), 1)
  const viejo = { ...p('presupuesto', 100), createdAt: hace(100) }
  check('la ventana deja afuera lo viejo', embudo([viejo, p('presupuesto', 2)], 7, ahora, 90).total, 1)
}

console.log('\nCAJAS PARADAS')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const ahora = new Date('2026-10-20T15:00:00Z')
  const hace = (d: number) => new Date(ahora.getTime() - d * 24 * 3600 * 1000)
  const l = (s: string, d: number | null) => ({ shippingStatus: s, shippingStatusAt: d == null ? null : hace(d) })
  check('se mide desde el último cambio de cualquier línea', diasSinMoverse([l('en_usa', 20), l('camino_usa', 3)], ahora) ?? -1, 3)
  check('una línea ya entregada también cuenta como movimiento', diasSinMoverse([l('entregado', 1), l('en_venezuela', 30)], ahora) ?? -1, 1)
  check('todo entregado: la caja terminó', si(diasSinMoverse([l('entregado', 40)], ahora) === null), 1)
  check('sin fechas no se inventa', si(diasSinMoverse([l('en_usa', null)], ahora) === null), 1)
}

console.log('\nSERVIR CON LO DEL DEPÓSITO')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const libre = { productId: 7, ensambleId: null, quantity: 2, envioId: null, shippingStatus: 'pendiente', costRealUsd: null, desdeStock: false }
  const pedido = { tipo: 'cliente', status: 'pedido' }
  const hay = { stock: 3, costoUnitUsd: 4.5 }
  check('pieza suelta libre con stock: se sirve', si(motivoNoServible(libre, pedido, hay) === null), 1)
  check('no alcanza el stock', si(motivoNoServible(libre, pedido, { stock: 1, costoUnitUsd: 4.5 }) !== null), 1)
  check('sin costo cargado no se sirve (vacío no es cero)', si(motivoNoServible(libre, pedido, { stock: 3, costoUnitUsd: null }) !== null), 1)
  check('ya comprada no se sirve', si(motivoNoServible({ ...libre, costRealUsd: 9 }, pedido, hay) !== null), 1)
  check('en una caja no se sirve', si(motivoNoServible({ ...libre, envioId: 4 }, pedido, hay) !== null), 1)
  check('un conjunto no se sirve', si(motivoNoServible({ ...libre, productId: null, ensambleId: 3 }, pedido, null) !== null), 1)
  check('un presupuesto sin confirmar no se sirve', si(motivoNoServible(libre, { tipo: 'cliente', status: 'presupuesto' }, hay) !== null), 1)
  check('el costo de la línea es el del inventario × cantidad', costoDeLinea(4.5, 2), 9)

  // Una línea servida no se quita ni cambia de cantidad (se devuelve al depósito primero); el precio sí.
  const servida: LineaActual = {
    id: 1, productId: 7, ensambleId: null, quantity: 2, salePrice: 10, bundleItems: null,
    shippingStatus: 'en_venezuela', costRealUsd: 9, nombre: 'Bujía', desdeStock: true,
  }
  const nueva = (q: number, precio: number): LineaNueva => ({ productId: 7, ensambleId: null, quantity: q, salePrice: precio, bundleItems: null })
  check('servida: no se quita', si(planEdicion([servida], []).error !== null), 1)
  check('servida: no baja la cantidad', si(planEdicion([servida], [nueva(1, 10)]).error !== null), 1)
  const precio = planEdicion([servida], [nueva(2, 12)])
  check('servida: el precio sí cambia', si(precio.error === null && precio.ops[0]?.op === 'precio'), 1)
  check('servida: la pantalla no deja quitarla', si(permisoDeLinea(servida).puedeQuitar === false), 1)
  check('con una línea servida el pedido no se cancela', si(motivoNoCancelable({ tipo: 'cliente', status: 'pedido', items: [servida] }) !== null), 1)
}

console.log('\nCONTEO DE LA CAJA')
// Se cuenta por código, no por línea: un conjunto se abre en sus piezas (× la cantidad de la
// línea) y la misma pieza en dos pedidos queda en una sola fila.
{
  const bp = (bajajCode: string | null, nameEs: string, quantity: number) => ({ nameEs, bajajCode, quantity, groupName: 'G' })
  const c = piezasAContar([
    { nombre: 'Bujía', codigo: 'B1', quantity: 2, piezas: [] },
    { nombre: 'Kit', codigo: null, quantity: 3, piezas: [bp('B1', 'Bujía', 1), bp(null, 'Arandela', 2)] },
  ])
  const de = (k: string) => c.find(p => p.clave === k)?.esperado ?? -1
  check('suelta + dentro de un conjunto se suman por código', de('B1'), 5)
  check('sin código se cuenta por nombre × cantidad del conjunto', de('Arandela'), 6)
  check('el conjunto en sí no es una fila', c.length, 2)
}

console.log('\nREENVÍO POR KILO  (₹/kg cotizado por caja + gastos fijos, sin seguro)')
// Las mismas piezas de la caja de Shoppre, por el otro reenvío: el tramo deja de salir de la
// tabla y pasa a ser kg cobrables × ₹/kg, y los cargos de Shoppre no aparecen.
{
  const cfgK: ConfigMap = { ...cfg, reenvio_kilo_gastos_inr: '1200' }
  const TARIFA = 850
  const k = calcEnvio(itemsShoppre, cfgK, { proveedor: provOemship, reenvio: { tipo: 'por_kilo', tarifaKgInr: TARIFA } })
  const tramoUsd = (5.5 * TARIFA) / 94.95
  check('tramo = kg cobrables × ₹/kg ÷ tasa', k.air.costUsd, tramoUsd)
  check('no toca la tabla de Shoppre', k.air.costUsd !== sh.air.costUsd ? 1 : 0, 1)
  check('una sola caja, sin tope de 22 kg', k.air.cajas, 1)
  check('sin seguro', k.insuranceUsd, 0)
  check('gastos fijos = ₹ de config ÷ tasa', k.processingUsd, 1200 / 94.95)
  check('no falta tarifa ni gastos', (k.reenvio.faltaTarifa ? 1 : 0) + (k.reenvio.faltaGastos ? 1 : 0), 0)
  check('tramo repartido por peso entre sus piezas (B pesa 3.5/5.5)', k.lines[1].airUsd, tramoUsd * 3.5 / 5.5)
  check('Σ landed por línea = landed total', k.lines.reduce((s, l) => s + l.landedUsd, 0), k.landedUsd)

  // Sin tarifa: la caja queda subcosteada y lo dice, no la cuenta gratis en silencio.
  const sinTarifa = calcEnvio(itemsShoppre, cfgK, { proveedor: provOemship, reenvio: { tipo: 'por_kilo', tarifaKgInr: null } })
  check('sin tarifa: tramo 0', sinTarifa.air.costUsd, 0)
  check('sin tarifa: faltaTarifa', sinTarifa.reenvio.faltaTarifa ? 1 : 0, 1)
  // Sin gastos en config: no se inventa un default.
  const sinGastos = calcEnvio(itemsShoppre, cfg, { proveedor: provOemship, reenvio: { tipo: 'por_kilo', tarifaKgInr: TARIFA } })
  check('sin gastos en config: 0 y faltaGastos', sinGastos.processingUsd + (sinGastos.reenvio.faltaGastos ? 1 : 0), 1)

  // La factura real reemplaza tarifa y gastos fijos, repartida por la misma dimensión que ata,
  // aunque nunca se haya cargado la tarifa (pisar un estimado 0 la repartía en partes iguales).
  const FACT = 70
  for (const [nombre, tarifa] of [['con tarifa', TARIFA], ['sin tarifa', null]] as const) {
    const f = calcEnvio(itemsShoppre, cfgK, {
      proveedor: provOemship, reenvio: { tipo: 'por_kilo', tarifaKgInr: tarifa }, fleteFacturado: { aereoUsd: FACT },
    })
    check(`facturado (${nombre}) pisa el tramo`, f.air.costUsd, FACT)
    check(`facturado (${nombre}) incluye los gastos fijos`, f.processingUsd, 0)
    check(`facturado (${nombre}) se reparte por peso`, f.lines[1].airUsd, FACT * 3.5 / 5.5)
    check(`facturado (${nombre}) ya no falta nada`, (f.reenvio.faltaTarifa ? 1 : 0) + (f.reenvio.faltaGastos ? 1 : 0), 0)
  }
  // Sin `reenvio` (catálogo, presupuestos, simulador) todo sigue siendo Shoppre.
  check('sin reenvío = Shoppre de siempre', sh.reenvio.tipo === 'shoppre' && sh.insuranceUsd > 0 ? 1 : 0, 1)

  // Tarifa de equilibrio: cotizada justo en ella, las dos rutas cuestan lo mismo.
  const shoppreUsd = sh.air.costUsd + sh.insuranceUsd + sh.processingUsd
  const eq = tarifaEquilibrioKgInr({ shoppreUsd, chargeableKg: sh.air.chargeableKg, gastosFijosInr: 1200, inrUsd: 94.95 })!
  const enEq = calcEnvio(itemsShoppre, cfgK, { proveedor: provOemship, reenvio: { tipo: 'por_kilo', tarifaKgInr: eq } })
  check('en la tarifa de equilibrio, por kilo = Shoppre', enEq.air.costUsd + enEq.processingUsd, shoppreUsd)
  check('gastos fijos más caros que Shoppre: equilibrio 0, no negativo',
    tarifaEquilibrioKgInr({ shoppreUsd: 10, chargeableKg: 5, gastosFijosInr: 5000, inrUsd: 94.95 })!, 0)
  check('caja sin kilos: sin equilibrio', tarifaEquilibrioKgInr({ shoppreUsd: 10, chargeableKg: 0, gastosFijosInr: 0, inrUsd: 94.95 }) == null ? 1 : 0, 1)
}

console.log('\nCAMBIAR EL REENVÍO DE UNA CAJA')
{
  const base = { modo: 'aereo', despachaProveedor: false, lineas: [{ shippingStatus: 'pendiente', isLanded: false }], fleteAereoFacturado: false, fleteAereoPagado: false }
  const no = (c: Partial<typeof base>) => (motivoNoCambiaReenvio({ ...base, ...c }) != null ? 1 : 0)
  const linea = (shippingStatus: string, isLanded = false) => [{ shippingStatus: 'pendiente', isLanded: false }, { shippingStatus, isLanded }]
  check('nada movido ni facturado: se puede', no({}), 0)
  // Comprar no decide el depósito: lo decide la dirección que se le dio al proveedor.
  check('camino al depósito (ya comprada): se puede', no({ lineas: linea('camino_shoppre') }), 0)
  check('en el depósito: se puede', no({ lineas: linea('en_shoppre') }), 0)
  check('una línea camino a USA: no', no({ lineas: linea('camino_usa') }), 1)
  check('una línea ya en Venezuela: no', no({ lineas: linea('en_venezuela') }), 1)
  check('una línea landed en Venezuela no cuenta (no pasa por depósito)', no({ lineas: linea('en_venezuela', true) }), 0)
  check('flete aéreo facturado: no', no({ fleteAereoFacturado: true }), 1)
  check('flete aéreo pagado: no', no({ fleteAereoPagado: true }), 1)
  check('proveedor que despacha él: no', no({ despachaProveedor: true }), 1)
  check('caja marítima: no', no({ modo: 'maritimo_cbm' }), 1)
}

console.log('\nTELÉFONO PARA WHATSAPP')
{
  const tel = (t: string | null) => Number(telefonoIntl(t) ?? 0)
  check('0414-123.45.67 → 58414…', tel('0414-123.45.67'), 584141234567)
  check('+58 414 1234567 igual', tel('+58 414 1234567'), 584141234567)
  check('414 1234567 sin el 0 igual', tel('414 1234567'), 584141234567)
  check('+1 305 555 1234 se respeta', tel('+1 305 555 1234'), 13055551234)
  check('incompleto → nada', tel('1234567'), 0)
}

console.log('\nMENSAJE AL CLIENTE')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const base = { nombre: 'Ana', pedidoId: 7, porComprar: 0, porPagar: { usd: 0, bcv: false, bs: null, divisas: 0 } }
  const llego = mensajeEstado({ ...base, etapa: 'en_venezuela', porPagar: { usd: 120, bcv: true, bs: 24000, divisas: 100 } })
  check('llegó: dice el monto BCV, los Bs y las divisas', si(llego.includes('$120.00') && llego.includes('Bs 24.000,00') && llego.includes('$100.00')), 1)
  check('nunca dice "saldo"', si(/saldo/i.test(llego)), 0)
  check('llegó y pagado: no pide plata', si(mensajeEstado({ ...base, etapa: 'en_venezuela' }).includes('pagado en su totalidad')), 1)
  check('en camino no habla de plata', si(mensajeEstado({ ...base, etapa: 'camino_usa', porPagar: { usd: 50, bcv: false, bs: null, divisas: 50 } }).includes('$')), 0)
  check('avisa lo que falta comprar', si(mensajeEstado({ ...base, etapa: 'en_venezuela', porComprar: 2 }).includes('Quedan 2 piezas')), 1)
}

// ── Envío express: Shoppre directo a Venezuela, con tope de landed por paquete ──
// Es la caja aérea sin Miami: el mismo seguro y processing de Shoppre, la tabla de Venezuela
// en vez de la de USA, y nada de marítimo. Encima, el landed del paquete no puede pasar del
// tope, y el precio sale de ESE landed (no del catálogo, que lleva el flete por Miami).
console.log('\nENVÍO EXPRESS')
{
  const ve = (kg: number, socio = false) => cotizarTramoAereo(kg, CARRIER_EXPRESS_VE, socio, cfg, 've').costUsd
  const inr = 94.95
  const pieza = (gramos: number, inrPrecio: number, dims: [number, number, number] = [20, 15, 10]): EnvioItemInput => ({
    pedidoId: 9, productId: 901, name: 'Express A', weightGrams: gramos, dimL: dims[0], dimA: dims[1], dimH: dims[2],
    priceInr: inrPrecio, quantity: 1, origen: 'india', inbound: 'shoppre', supplierId: null,
  })

  check('la tabla de Venezuela no es la de USA', ve(1) !== cotizarTramoAereo(1, CARRIER, false).costUsd ? 1 : 0, 1)

  const e = calcExpress([pieza(800, 2000)], cfg)
  const producto = 2000 / inr
  const esperado = producto + ve(0.8) + producto * 0.03 + 500 / inr
  check('express: flete de la tabla de Venezuela', e.envio.airUsd, ve(0.8))
  check('express: no paga marítimo', e.envio.maritimeUsd, 0)
  check('express: seguro de Shoppre sobre el producto', e.envio.insuranceUsd, producto * 0.03)
  check('express: processing de Shoppre', e.envio.processingUsd, 500 / inr)
  check('express: landed = producto + flete + seguro + processing', e.landedUsd, esperado)
  check('express: holgura contra el tope', e.holguraUsd, 100 - esperado)
  check('express: no se pasa', e.excede ? 1 : 0, 0)
  check('express: producto que entra (descontando el seguro)', e.productoQueEntraUsd, (100 - esperado) / 1.03)
  check('express: kg hasta el próximo escalón', e.kgHastaProximoEscalon ?? -1, 0.2, 1e-9)

  const socio = calcExpress([pieza(800, 2000)], { ...cfg, shoppre_member: 'true' })
  check('express: tarifa de socio también a Venezuela', socio.envio.airUsd, Number((ve(0.8) * 0.95).toFixed(2)), 0.0001)

  // El volumétrico manda: 1 kg real en una caja de 30 cm de lado se cobra como 5.4 kg.
  const bulto = calcExpress([pieza(1000, 2000, [30, 30, 30])], cfg)
  check('express: cobra el volumétrico (5.4 kg)', bulto.envio.air.chargeableKg, 5.4, 1e-9)
  check('express: y lo cobra a la tarifa de 5.4 kg', bulto.envio.airUsd, ve(5.4))

  const pesado = calcExpress([pieza(3000, 4000)], cfg)
  check('express: 3 kg con $42 de producto se pasa', pesado.excede ? 1 : 0, 1)
  check('express: dice por cuánto', pesado.holguraUsd, 100 - pesado.landedUsd)
  check('express: pasado no entra más producto', pesado.productoQueEntraUsd, 0)

  // La factura de Shoppre trae el processing adentro: pisa a la tabla y no se suma dos veces.
  const facturado = calcExpress([pieza(800, 2000)], cfg, { fleteUsd: 50 })
  check('express: el flete facturado pisa la tabla', facturado.envio.airUsd, 50)
  check('express: y el processing no se cuenta dos veces', facturado.envio.processingUsd, 0)

  // Precio: landed por unidad / (1 − margen), redondeado al centavo.
  const conMargen = calcExpress([{ ...pieza(800, 2000), quantity: 2 }], cfg, { margen: 0.3 })
  const unit = Math.round((conMargen.landedUsd / 2 / 0.7) * 100) / 100
  check('express: precio por unidad sale del landed del paquete', conMargen.lineas[0].precioUnitUsd, unit)
  check('express: precio total = unidad × cantidad', conMargen.precioUsd, unit * 2, 1e-9)
  check('express: margen por defecto es express_margen_pct', calcExpress([pieza(800, 2000)], { ...cfg, express_margen_pct: '25' }).margen, 0.25)
  check('express: tope configurable', calcExpress([pieza(800, 2000)], { ...cfg, express_tope_usd: '120' }).topeUsd, 120)

  // Confirmar un presupuesto express: pasado del tope o sin peso, no.
  const si = (b: boolean) => (b ? 1 : 0)
  check('confirmar: el que entra se confirma', si(motivoExpressNoAprobable(e) == null), 1)
  check('confirmar: el pasado del tope no', si(motivoExpressNoAprobable(pesado)?.includes('tope') ?? false), 1)
  const sinPeso = calcExpress([{ ...pieza(800, 2000), weightGrams: null, name: 'Sin pesar' }], cfg)
  check('confirmar: sin peso no (no se sabe si entra)', si(motivoExpressNoAprobable(sinPeso)?.includes('Sin pesar') ?? false), 1)
  check('vía: express se lee', si(viaDe('express') === 'express'), 1)
  check('vía: cualquier otra cosa es normal', si(viaDe('expres') === 'normal' && viaDe(null) === 'normal'), 1)

  // Y la caja aérea de siempre no se enteró: sigue con la tabla de USA y su marítimo.
  const aereo = calcEnvio([pieza(800, 2000)], cfg, { modo: 'aereo' })
  check('aéreo: sigue con la tabla de USA', aereo.airUsd, q(0.8).costUsd)
  check('aéreo: sigue pagando marítimo', aereo.maritimeUsd > 0 ? 1 : 0, 1)
}

console.log('\nTRACKINGS DE LA CAJA')
{
  const si = (b: boolean) => (b ? 1 : 0)
  const n = (r: ReturnType<typeof leerTrackingsTramo>) => ('filas' in r ? r.filas.length : -1)
  check('tres paquetes locales', n(leerTrackingsTramo('local', ['A1', ' B2 ', 'C3'], ['Delhivery', '', ''])), 3)
  check('el renglón vacío se descarta', n(leerTrackingsTramo('local', ['A1', '  '], ['', ''])), 1)
  check('transportista sin número: rechazo', n(leerTrackingsTramo('usa', [''], ['Shoppre'])), -1)
  check('repetido (sin importar mayúsculas): rechazo', n(leerTrackingsTramo('usa', ['shp-1', 'SHP-1'], ['', ''])), -1)
  const once = Array.from({ length: MAX_TRACKINGS_POR_TRAMO + 1 }, (_, i) => `T${i}`)
  check('más del tope: rechazo', n(leerTrackingsTramo('usa', once, once.map(() => ''))), -1)
  check('justo el tope: pasa', n(leerTrackingsTramo('usa', once.slice(1), once.slice(1).map(() => ''))), MAX_TRACKINGS_POR_TRAMO)
  const r = resumenTrackings([
    { tramo: 'usa', numero: 'SHP-1', transportista: 'Shoppre' },
    { tramo: 'local', numero: 'A1', transportista: 'Delhivery' },
    { tramo: 'local', numero: 'B2', transportista: null },
  ])
  check('resumen en orden de viaje', si(r === 'local A1, B2 (Delhivery) · USA SHP-1 (Shoppre)'), 1)
}

console.log(`\n${fallos === 0 ? '✅ todo ok' : `❌ ${fallos} fallos`}\n`)
process.exit(fallos === 0 ? 0 : 1)
