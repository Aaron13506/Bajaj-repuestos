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
import {
  compararCompra, MONTOS_VACIOS,
  type MontosProveedor, type PiezaCompra, type ProveedorOpcion,
} from '../lib/comparar-compra'
import { parseListaSkus } from '../lib/lista-skus'
import { cotizarTramoAereo, capacidadCajaKg } from '../lib/shipping-rates'
import { repartirEnCentavos } from '../lib/reparto-compra'
import { financiamientoEnvio } from '../lib/financiamiento-envio'
import { estadoFlete, excedeFacturado, resumenFletes } from '../lib/flete-real'
import { motivoNoEliminable, type PedidoBorrable } from '../lib/pedido-eliminable'
import { motivoProveedorEnUso } from '../lib/proveedor-en-uso'
import { motivoProductoEnUso } from '../lib/producto-en-uso'
import { compatibleModelsFrom } from '../lib/modelo'

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
  check('resumen: todo pagado', uno(resumenFletes([
    { facturadoUsd: 316, pagadoUsd: 316 }, { facturadoUsd: 48, pagadoUsd: 48 },
  ]) === 'pagado'), 1)
}

console.log(`\n${fallos === 0 ? '✅ todo ok' : `❌ ${fallos} fallos`}\n`)
process.exit(fallos === 0 ? 0 : 1)
