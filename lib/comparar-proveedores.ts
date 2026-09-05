import { db } from './db'
import { cbmParams, type ConfigMap } from './calc'

// ─────────────────────────────────────────────────────────────────────────────
// ¿A quién conviene comprarle ESTE embarque?
//
// La comparación tiene que hacerse sobre el EMBARQUE COMPLETO, no pieza por pieza, porque
// el FOB es un monto fijo por embarque: no se puede prorratear y después comparar. Un
// proveedor con piezas más baratas pero FOB de $750 pierde en una caja chica y gana en una
// grande, y ese cruce es justamente la decisión que hay que tomar.
//
//   total = Σ precios de las piezas  +  m³ facturable × tarifa  +  FOB del proveedor
//
// La comisión del giro NO entra: se anota por embarque, después de transferir, así que
// todavía no existe cuando se elige a quién comprarle. Estimarla con un porcentaje
// guardado en el proveedor la metería en la comparación como si fuera un dato, y sería un
// número inventado decidiendo la compra. Cuando importa —Garuda cobra, otros no— se ve en
// el embarque ya armado, que es donde el número es real.
//
// La COBERTURA es el otro dato que no puede faltar: un proveedor que solo cotiza 3 de tus
// 20 piezas parece barato porque las otras 17 caen al precio base de 99rpm. Sin verla, el
// ganador termina siendo el que menos cotiza.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaComparable {
  productId: number
  quantity: number
  priceInr: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

export interface OpcionProveedor {
  /** null = 99rpm, el precio base en ₹ del catálogo. */
  supplierId: number | null
  nombre: string
  /** Cuántas de las piezas del embarque tiene cotizadas este proveedor. */
  piezasCotizadas: number
  totalPiezas: number
  /**
   * Las que NO cotiza, por productId. El contador solo sirve para descartar al proveedor;
   * para actuar hace falta saber CUÁLES son — son las que hay que pedirle a otro, y esa
   * lista es la mitad de la decisión que esta tabla existe para tomar.
   */
  noCotizadas: number[]
  /** Piezas que ni él ni 99rpm cotizan: entran al total como 0 y lo dejan corto. */
  sinPrecio: number
  /** Las anteriores, por productId: son las que hacen que el total esté mal, no solo corto. */
  sinPrecioIds: number[]
  costoOrigenUsd: number
  volumeM3: number
  fleteUsd: number
  fobUsd: number
  /** true si el FOB sale del default global porque el proveedor no tiene el suyo cargado. */
  fobPorDefecto: boolean
  totalUsd: number
  esActual: boolean
  /**
   * ¿Se le puede comprar este embarque a este proveedor? Un proveedor que no cotiza NINGUNA
   * de las piezas no es una opción barata: es una opción imposible — su total sale de los
   * precios de 99rpm con su FOB, un número que no corresponde a ninguna compra real.
   */
  viable: boolean
}

export async function compararProveedores(
  lineas: LineaComparable[],
  cfg: ConfigMap,
  actualId: number | null,
): Promise<OpcionProveedor[]> {
  if (lineas.length === 0) return []

  const [suppliers, precios] = await Promise.all([
    db.supplier.findMany({ select: { id: true, name: true, fobUsd: true }, orderBy: { name: 'asc' } }),
    db.supplierPrice.findMany({
      where: { productId: { in: lineas.map(l => l.productId) } },
      select: { supplierId: true, productId: true, priceUsd: true, isLanded: true },
    }),
  ])

  // `${supplierId}:${productId}` → precio, para no recorrer el array por cada celda.
  const porPar = new Map(
    precios.map(p => [
      `${p.supplierId}:${p.productId}`,
      { priceUsd: parseFloat(p.priceUsd.toString()), isLanded: p.isLanded },
    ]),
  )

  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')
  const fobDefault = cbmParams(cfg).fobUsd
  const { ratePerM3, minM3 } = cbmParams(cfg)

  const evaluar = (supplierId: number | null, nombre: string, fobPropio: number | null): OpcionProveedor => {
    let costoOrigenUsd = 0
    let volumeM3 = 0
    let piezasCotizadas = 0
    const noCotizadas: number[] = []
    const sinPrecioIds: number[] = []

    for (const l of lineas) {
      const override = supplierId != null ? porPar.get(`${supplierId}:${l.productId}`) : undefined
      if (override) piezasCotizadas++
      else noCotizadas.push(l.productId)

      const unit = override?.priceUsd ?? (l.priceInr != null ? l.priceInr / inrUsd : null)
      if (unit == null) sinPrecioIds.push(l.productId)
      costoOrigenUsd += (unit ?? 0) * l.quantity

      // El proveedor que cotiza puesto en Venezuela no manda esa pieza en el contenedor:
      // no ocupa volumen, así que puede bajar el flete de todo el embarque.
      const viaja = !(override?.isLanded ?? false)
      if (viaja && l.dimL && l.dimA && l.dimH) {
        volumeM3 += ((l.dimL * l.dimA * l.dimH) / 1_000_000) * l.quantity
      }
    }

    const fobUsd = fobPropio ?? fobDefault
    // El mínimo facturable aplica igual: es de la naviera, no del proveedor.
    const fleteUsd = Math.max(volumeM3, minM3) * ratePerM3

    return {
      supplierId,
      nombre,
      piezasCotizadas,
      totalPiezas: lineas.length,
      noCotizadas,
      sinPrecio: sinPrecioIds.length,
      sinPrecioIds,
      costoOrigenUsd,
      volumeM3,
      fleteUsd,
      fobUsd,
      fobPorDefecto: fobPropio == null,
      totalUsd: costoOrigenUsd + fleteUsd + fobUsd,
      esActual: supplierId === actualId,
      viable: supplierId == null || piezasCotizadas > 0,
    }
  }

  const opciones = [
    // 99rpm es la base: cotiza todo el catálogo, así que su cobertura es siempre completa.
    // `noCotizadas` queda vacía por lo mismo — lo que le falte a una pieza acá no es un
    // hueco de cobertura sino un precio sin cargar, y eso ya lo dice `sinPrecioIds`.
    { ...evaluar(null, '99rpm (base)', null), piezasCotizadas: lineas.length, noCotizadas: [] },
    ...suppliers.map(s =>
      evaluar(s.id, s.name, s.fobUsd != null ? parseFloat(s.fobUsd.toString()) : null),
    ),
  ]

  // Las no viables van al fondo: se listan para saber que existen y que no cotizan nada,
  // pero nunca pueden encabezar la comparación.
  return opciones.sort((a, b) => Number(b.viable) - Number(a.viable) || a.totalUsd - b.totalUsd)
}
