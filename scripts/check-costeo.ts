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

import { calcEnvio, type ConfigMap, type EnvioItemInput, type ProveedorEnvio } from '../lib/calc'
import {
  compararCompra, MONTOS_VACIOS,
  type MontosProveedor, type PiezaCompra, type ProveedorOpcion,
} from '../lib/comparar-compra'
import { parseListaSkus } from '../lib/lista-skus'
import { cotizarTramoAereo, capacidadCajaKg } from '../lib/shipping-rates'

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

console.log(`\n${fallos === 0 ? '✅ todo ok' : `❌ ${fallos} fallos`}\n`)
process.exit(fallos === 0 ? 0 : 1)
