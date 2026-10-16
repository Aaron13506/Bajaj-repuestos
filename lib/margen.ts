// Margen realizado: cuánto se ganó (puro, sin DB: lo usan el server, las pantallas y check:costeo).
//
// El sistema sabía costear con precisión y no decía si se ganó. La ficha de una caja tiene su
// margen, pero un pedido repartido en varias cajas no tenía el suyo, y no había nada por mes.
// Con un margen de 30% la diferencia entre lo cotizado y lo que de verdad costó es todo el
// negocio (un presupuesto aislado puede ir de −133% a +37% por los escalones del flete).
//
// Todo en dólares REALES: es la unidad de la caja y de los costos (ver lib/cobro-bcv.ts). La
// venta de una línea es `salePrice × cantidad`; el dólar BCV es solo cómo se le presentó al
// cliente y no entra acá.
//
// El margen se reconoce al ENTREGAR, no al cobrar: lo cobrado y lo por cobrar ya tienen su lugar
// (Contabilidad). Lo que se pregunta acá es si la mercancía que se entregó se vendió por más de
// lo que costó traerla.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface LineaMargen {
  /** salePrice × cantidad, en dólares reales. */
  ventaUsd: number
  /**
   * Lo que costó esa línea puesta acá (landed, como lo costea su caja; en una venta del
   * depósito, lo que costaba lo vendido). null = no se sabe: la línea no está en ninguna caja
   * ni tiene un costo real cargado.
   */
  costoUsd: number | null
  /** El costo es el que se pagó de verdad (compra, flete y caja facturados), no un estimado. */
  costoReal: boolean
  entregada: boolean
  entregadaAt: Date | null
}

// realizado           entregado y costado con lo que de verdad se pagó.
// estimado            entregado, pero algún costo (compra, flete, peso de la caja) sigue siendo
//                     el de tabla: el margen es una buena aproximación, no un cierre.
// sin_costo           entregado y alguna línea no tiene costo: no se puede decir cuánto se ganó.
// en_curso            todavía le falta entregar: el margen es una proyección.
export type EstadoMargen = 'realizado' | 'estimado' | 'sin_costo' | 'en_curso'

export interface MargenPedido {
  ventaUsd: number
  /**
   * Lo que se perdió en piezas que no se entregaron y se le reembolsaron al cliente (ver
   * lib/incidencias.ts). Ya está restado del margen: el costo de esas unidades salió de su
   * línea, y tenía que quedar en algún lado.
   */
  perdidasUsd: number
  /**
   * Lo que la brecha le quitó (+) o dio (−) a los cobros en Bs de este pedido a BCV
   * (Movimiento 'diferencia_brecha'). Ya está dentro del costo: el negocio la asume.
   */
  brechaUsd: number
  /** Suma de las líneas con costo. Con `sinCosto > 0` es un piso. */
  costoUsd: number
  /** null mientras alguna línea no tenga costo. */
  margenUsd: number | null
  /** Ganancia sobre el precio de venta (la misma definición de margen que el catálogo). */
  margenPct: number | null
  sinCosto: number
  estado: EstadoMargen
  /** Cuándo se entregó la última línea. null = no entregado. */
  entregadoAt: Date | null
}

export interface PerdidasPedido {
  /** Suma de lo perdido en reembolsos (Incidencia.perdidaUsd). */
  perdidasUsd: number
  /** Cuándo se registró la última, para ubicar el mes de un pedido que quedó sin líneas. */
  ultimaAt: Date | null
  /** Ver MargenPedido.brechaUsd. */
  brechaUsd?: number
}

export function margenDePedido(lineas: LineaMargen[], perdidas: PerdidasPedido = { perdidasUsd: 0, ultimaAt: null }): MargenPedido {
  const ventaUsd = round2(lineas.reduce((s, l) => s + l.ventaUsd, 0))
  const conCosto = lineas.filter(l => l.costoUsd != null)
  const costoLineas = conCosto.reduce((s, l) => s + (l.costoUsd as number), 0)
  const perdidasUsd = round2(perdidas.perdidasUsd)
  const brechaUsd = round2(perdidas.brechaUsd ?? 0)
  // La pérdida es costo del pedido: el de las unidades que se pagaron y no se entregaron. La
  // brecha también: es plata de la venta que no llegó a la caja.
  const costoUsd = round2(costoLineas + perdidasUsd + brechaUsd)
  const sinCosto = lineas.length - conCosto.length
  // Un pedido al que se le reembolsó todo se quedó sin líneas: terminó, y terminó en pérdida.
  const sinLineas = lineas.length === 0 && perdidasUsd > 0
  const entregado = sinLineas || (lineas.length > 0 && lineas.every(l => l.entregada))

  const margenUsd = sinCosto === 0 ? round2(ventaUsd - costoUsd) : null
  const fechas = lineas.flatMap(l => (l.entregadaAt ? [l.entregadaAt.getTime()] : []))
  if (sinLineas && perdidas.ultimaAt) fechas.push(perdidas.ultimaAt.getTime())

  const estado: EstadoMargen = !entregado
    ? 'en_curso'
    : sinCosto > 0
      ? 'sin_costo'
      : lineas.every(l => l.costoReal) ? 'realizado' : 'estimado'

  return {
    ventaUsd,
    perdidasUsd,
    brechaUsd,
    costoUsd,
    margenUsd,
    margenPct: margenUsd != null && ventaUsd > 0 ? (margenUsd / ventaUsd) * 100 : null,
    sinCosto,
    estado,
    entregadoAt: entregado && fechas.length > 0 ? new Date(Math.max(...fechas)) : null,
  }
}

// Venezuela no tiene horario de verano: UTC−4 todo el año. El mes se corta ahí y no en UTC, o
// una entrega de la noche del 31 caería en el mes siguiente.
export function mesDe(d: Date): string {
  return new Date(d.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 7)
}

export interface MovimientoResultado {
  fecha: Date
  categoria: string
  monto: number
}

export interface MesResultado {
  mes: string
  pedidos: number
  ventaUsd: number
  costoUsd: number
  /** Margen de los pedidos entregados con costo (realizados + estimados). */
  margenUsd: number
  margenPct: number | null
  /** La parte del margen que todavía descansa en un costo estimado. */
  margenEstimadoUsd: number
  /** Pedidos entregados ese mes a los que no se les sabe el costo: no suman al margen. */
  pedidosSinCosto: number
  /**
   * Lo que se quedó el negocio de pedidos cancelados ese mes (lo cobrado que no se devolvió).
   * Es plata que entró y no tiene una venta detrás: suma al resultado.
   */
  cancelacionesUsd: number
  gastosUsd: number
  /** Lo que costó pasar Bs a USDT ese mes (negativo = se ganó). */
  conversionUsd: number
  resultadoUsd: number
}

// Las categorías del libro que son gasto del negocio y NO están ya dentro del costo de un pedido.
// El flete, la comisión del giro y el pago al proveedor entran por el landed de cada caja:
// contarlos otra vez acá los descontaría dos veces.
const CATEGORIAS_GASTO = ['gasto_operativo', 'otro_egreso']

export interface CancelacionResultado {
  fecha: Date
  /** Lo cobrado que el negocio se quedó (depositUsd de un pedido cancelado, ya neto de lo devuelto). */
  retenidoUsd: number
}

export function resultadoPorMes(
  pedidos: { margen: MargenPedido; fecha: Date }[],
  movimientos: MovimientoResultado[],
  cancelaciones: CancelacionResultado[] = [],
): MesResultado[] {
  const meses = new Map<string, MesResultado>()
  const mes = (clave: string) => {
    let m = meses.get(clave)
    if (!m) {
      m = {
        mes: clave, pedidos: 0, ventaUsd: 0, costoUsd: 0, margenUsd: 0, margenPct: null, margenEstimadoUsd: 0,
        pedidosSinCosto: 0, cancelacionesUsd: 0, gastosUsd: 0, conversionUsd: 0, resultadoUsd: 0,
      }
      meses.set(clave, m)
    }
    return m
  }

  for (const { margen, fecha } of pedidos) {
    if (margen.estado === 'en_curso') continue
    const m = mes(mesDe(fecha))
    if (margen.estado === 'sin_costo') { m.pedidosSinCosto++; continue }
    m.pedidos++
    m.ventaUsd += margen.ventaUsd
    m.costoUsd += margen.costoUsd
    m.margenUsd += margen.margenUsd ?? 0
    if (margen.estado === 'estimado') m.margenEstimadoUsd += margen.margenUsd ?? 0
  }

  for (const c of cancelaciones) mes(mesDe(c.fecha)).cancelacionesUsd += c.retenidoUsd

  for (const mov of movimientos) {
    if (CATEGORIAS_GASTO.includes(mov.categoria)) mes(mesDe(mov.fecha)).gastosUsd += mov.monto
    else if (mov.categoria === 'conversion_salida') mes(mesDe(mov.fecha)).conversionUsd += mov.monto
    else if (mov.categoria === 'conversion_entrada') mes(mesDe(mov.fecha)).conversionUsd -= mov.monto
  }

  return [...meses.values()]
    .map(m => {
      const margenUsd = round2(m.margenUsd)
      const gastosUsd = round2(m.gastosUsd)
      const conversionUsd = round2(m.conversionUsd)
      const cancelacionesUsd = round2(m.cancelacionesUsd)
      return {
        ...m,
        ventaUsd: round2(m.ventaUsd),
        costoUsd: round2(m.costoUsd),
        margenUsd,
        margenPct: m.ventaUsd > 0 ? (margenUsd / m.ventaUsd) * 100 : null,
        margenEstimadoUsd: round2(m.margenEstimadoUsd),
        cancelacionesUsd,
        gastosUsd,
        conversionUsd,
        resultadoUsd: round2(margenUsd + cancelacionesUsd - gastosUsd - conversionUsd),
      }
    })
    .sort((a, b) => b.mes.localeCompare(a.mes))
}
