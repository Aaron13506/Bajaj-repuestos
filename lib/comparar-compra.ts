import { calcEnvio, type ConfigMap, type EnvioBreakdown, type EnvioItemInput } from './calc'
import { inboundDe, type Inbound } from './inbound'
import { cantidadMinima } from './moq'

// ─────────────────────────────────────────────────────────────────────────────
// ¿A quién le compro ESTA lista, y gano o pierdo contra el camino de siempre?
//
// Es el gemelo aéreo de lib/comparar-proveedores.ts, y son dos módulos y no uno porque
// comparan cosas distintas. Aquel compara un EMBARQUE marítimo, donde el flete es volumen
// por tarifa y el FOB es un fijo por caja; este compara una COMPRA que va a viajar por
// aire, donde el tramo a USA depende de por dónde entra el proveedor:
//
//   shoppre   → una sola consulta a la tabla escalón de ShipGlobal sobre el peso cobrable
//               del grupo, más seguro y processing de Shoppre.
//   cotizado  → el total plano que el proveedor factura, sin nada encima (es DDP).
//
// De ahí en adelante los dos pagan el mismo marítimo USA→Venezuela, así que la diferencia
// entre dos opciones es exactamente lo que cambia: mercancía + tramo + cargos de Shoppre.
//
// Todo el costeo pasa por `calcEnvio`, no por una cuenta propia. Si esta comparación
// tuviera su propia aritmética, elegiría proveedor con un número que no es el que después
// va a mostrar el envío real — y la decisión se toma acá, pero se paga allá.
//
// El módulo es PURO (no toca la base) para poder recalcular en el navegador con cada
// tecla: las tarifas y los dos montos del proveedor se mueven a mano mientras se compara,
// y un viaje al servidor por tecla haría inusable la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

export interface PiezaCompra {
  productId: number
  /** El código, para poder nombrar en los avisos la pieza que falla. */
  sku: string
  nombre: string
  qty: number
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  /** Precio base de 99rpm en ₹. Es el que se usa cuando el proveedor no cotiza la pieza. */
  priceInr: number | null
}

export interface ProveedorOpcion {
  /** null = 99rpm, el precio base en ₹ del catálogo, por Shoppre. */
  id: number | null
  nombre: string
  origen: string
  inbound: string
}

export interface PrecioPar {
  supplierId: number
  productId: number
  priceUsd: number
  isLanded: boolean
  moq: number | null
}

/** Los montos que nadie puede derivar y que hay que tipear para poder comparar. */
export interface MontosProveedor {
  /** Solo 'cotizado': lo que el proveedor cobra por llevar la caja a USA (DDP). */
  tramoUsd: number | null
  /** Lo que cobra mi banco por emitir el giro. Ver lib/inbound.ts. */
  comisionSalienteUsd: number | null
  /** Lo que le descuentan a él al acreditar y hay que completarle. */
  comisionEntranteUsd: number | null
}

export const MONTOS_VACIOS: MontosProveedor = {
  tramoUsd: null,
  comisionSalienteUsd: null,
  comisionEntranteUsd: null,
}

export interface FaltaMoq {
  sku: string
  pedida: number
  minima: number
}

export interface OpcionCompra {
  supplierId: number | null
  nombre: string
  inbound: Inbound
  origen: string
  b: EnvioBreakdown
  landedUsd: number
  /** El landed sacándole el tramo cotizado: la base sobre la que se calcula el tope. */
  landedSinTramoUsd: number
  /** Cuántas piezas de la lista cotiza este proveedor. */
  cotizadas: number
  totalPiezas: number
  /** Las que NO cotiza: caen al precio base de 99rpm y por eso parece más barato de lo que es. */
  noCotizadas: string[]
  /** Ni él ni 99rpm les ponen precio: entran como 0 y dejan el total corto, no solo impreciso. */
  sinPrecio: string[]
  /** Piezas que llegan puestas en Venezuela: no viajan en la caja ni pagan flete. */
  landedDirecto: string[]
  /** Piezas cuyo mínimo de compra obliga a llevar más de lo pedido. */
  moq: FaltaMoq[]
  unidadesExtra: number
  /**
   * Un proveedor que no cotiza NINGUNA pieza no es la opción barata: es una opción
   * imposible. Su total sale íntegro de los precios de 99rpm y no corresponde a ninguna
   * compra que se pueda hacer.
   */
  viable: boolean
  /**
   * Solo 'cotizado': hasta cuánto puede cobrar el tramo a USA sin dejar de convenir contra
   * la referencia. Es EL número de la comparación — el proveedor todavía no pasó su
   * cotización de envío, así que lo útil no es el total sino el techo que tiene.
   * null cuando la opción es la referencia misma, o cuando entra por Shoppre (ahí el
   * tramo no se negocia: lo pone la tabla).
   */
  tramoTopeUsd: number | null
  /** Diferencia contra la referencia. Positivo = esta opción sale MÁS BARATA. */
  ahorroUsd: number
  esReferencia: boolean
}

export interface OpcionesCompra {
  opciones: OpcionCompra[]
  referencia: OpcionCompra | null
}

const clave = (supplierId: number | null, productId: number) => `${supplierId}:${productId}`

/** Clave con la que se indexan los montos tipeados. 99rpm no tiene giro, pero sí fila. */
export const claveMontos = (supplierId: number | null) => (supplierId == null ? 'base' : String(supplierId))

function costearOpcion(
  prov: ProveedorOpcion,
  piezas: PiezaCompra[],
  porPar: Map<string, PrecioPar>,
  cfg: ConfigMap,
  montos: MontosProveedor,
  aplicarMoq: boolean,
): Omit<OpcionCompra, 'tramoTopeUsd' | 'ahorroUsd' | 'esReferencia'> {
  const inbound = inboundDe(prov.origen, prov.inbound)

  const noCotizadas: string[] = []
  const sinPrecio: string[] = []
  const landedDirecto: string[] = []
  const moq: FaltaMoq[] = []
  let cotizadas = 0
  let unidadesExtra = 0

  // 99rpm es la base, no un proveedor con lista propia: cotiza todo el catálogo, así que su
  // cobertura es completa por definición. Contarle "no cotiza 22 de 22" era leer la ausencia
  // de SupplierPrice como un hueco, cuando el precio base ES su precio — y el aviso decía
  // "esas entran al precio base de 99rpm" en la tarjeta de 99rpm. Lo que sí puede faltarle a
  // una pieza acá es el `priceInr`, y eso ya lo dice `sinPrecio`.
  const esBase = prov.id == null

  const items: EnvioItemInput[] = piezas.map(p => {
    const precio = prov.id != null ? porPar.get(clave(prov.id, p.productId)) : undefined
    if (precio || esBase) cotizadas++
    else noCotizadas.push(p.sku)
    if (precio?.isLanded) landedDirecto.push(p.sku)
    if (!precio && p.priceInr == null) sinPrecio.push(p.sku)

    // El MOQ sube la CANTIDAD, nunca el precio unitario. Y sube el volumen de la caja, así
    // que se aplica antes de costear o el flete queda calculado sobre una caja que no es.
    const minima = aplicarMoq ? cantidadMinima(p.qty, precio?.moq) : p.qty
    if (minima > p.qty) {
      moq.push({ sku: p.sku, pedida: p.qty, minima })
      unidadesExtra += minima - p.qty
    }

    return {
      pedidoId: 0,
      productId: p.productId,
      name: `${p.sku} · ${p.nombre}`,
      weightGrams: p.weightGrams,
      dimL: p.dimL,
      dimA: p.dimA,
      dimH: p.dimH,
      priceInr: p.priceInr,
      // Sin precio del proveedor cae al base de 99rpm en ₹: es lo que costaría comprarle
      // esa pieza a otro, no un cero.
      priceUsd: precio?.priceUsd ?? null,
      quantity: minima,
      origen: prov.origen === 'china' ? 'china' : 'india',
      inbound,
      supplierId: prov.id,
      isLanded: precio?.isLanded ?? false,
    }
  })

  const b = calcEnvio(items, cfg, {
    modo: 'aereo',
    // 99rpm no lleva giro: se paga de otra forma y no hay transferencia que comisionar.
    proveedor: prov.id != null
      ? {
          supplierId: prov.id,
          nombre: prov.nombre,
          tramoUsd: montos.tramoUsd,
          comisionSalienteUsd: montos.comisionSalienteUsd,
          comisionEntranteUsd: montos.comisionEntranteUsd,
        }
      : null,
  })

  return {
    supplierId: prov.id,
    nombre: prov.nombre,
    inbound,
    origen: prov.origen,
    b,
    landedUsd: b.landedUsd,
    // El tramo entra al landed de forma lineal y nada más depende de él (el seguro va
    // sobre la mercancía, el processing es fijo y el marítimo es volumen), así que
    // restarlo da exactamente el landed que tendría con envío gratis.
    landedSinTramoUsd: b.landedUsd - (b.tramo?.costUsd ?? 0),
    cotizadas,
    totalPiezas: piezas.length,
    noCotizadas,
    sinPrecio,
    landedDirecto,
    moq,
    unidadesExtra,
    viable: prov.id == null || cotizadas > 0,
  }
}

/**
 * Costea la misma lista con cada proveedor y las ordena por landed.
 *
 * `referenciaId` es contra quién se mide el ahorro — el camino de siempre, que por defecto
 * es 99rpm por Shoppre. Sin una referencia fija la tabla solo diría quién gana; la
 * pregunta real es "¿cuánto gano o pierdo contra lo que ya hago?".
 */
export function compararCompra(
  piezas: PiezaCompra[],
  proveedores: ProveedorOpcion[],
  precios: PrecioPar[],
  cfg: ConfigMap,
  montos: Record<string, MontosProveedor>,
  opts: { aplicarMoq?: boolean; referenciaId?: number | null } = {},
): OpcionesCompra {
  if (piezas.length === 0) return { opciones: [], referencia: null }

  const aplicarMoq = opts.aplicarMoq ?? true
  const referenciaId = opts.referenciaId ?? null
  const porPar = new Map(precios.map(p => [clave(p.supplierId, p.productId), p]))
  const sinMontos = MONTOS_VACIOS

  const crudas = proveedores.map(prov =>
    costearOpcion(prov, piezas, porPar, cfg, montos[claveMontos(prov.id)] ?? sinMontos, aplicarMoq),
  )

  const ref = crudas.find(o => o.supplierId === referenciaId) ?? null

  const opciones: OpcionCompra[] = crudas.map(o => {
    const esReferencia = ref != null && o.supplierId === ref.supplierId
    return {
      ...o,
      esReferencia,
      ahorroUsd: ref ? ref.landedUsd - o.landedUsd : 0,
      // Con envío gratis todavía tiene que ganarle a la referencia para que exista un
      // tope: si ya pierde en $0 de flete, ningún precio de envío lo salva y el número
      // correcto es 0, no uno negativo que se leería como "te puede cobrar".
      tramoTopeUsd:
        ref && !esReferencia && o.inbound === 'cotizado' && o.viable
          ? Math.max(ref.landedUsd - o.landedSinTramoUsd, 0)
          : null,
    }
  })

  // Las no viables al fondo: se listan para saber que existen y que no cotizan nada, pero
  // nunca pueden encabezar la comparación.
  opciones.sort((a, b) => Number(b.viable) - Number(a.viable) || a.landedUsd - b.landedUsd)

  return { opciones, referencia: opciones.find(o => o.esReferencia) ?? null }
}
