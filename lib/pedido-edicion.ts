// Editar un pedido YA confirmado (puro, sin DB: lo usan el server, la pantalla y check:costeo).
//
// Un pedido por encargo se corrige todo el tiempo: el proveedor no tiene la pieza, Bajaj la
// reemplazó por otro código, el cliente pide menos. Antes un pedido confirmado no se podía
// tocar y no había camino. Lo que hace difícil editarlo es que sus líneas ya pueden estar
// COMPRADAS: la plata salió, la pieza viaja en una caja, y borrar la línea borraría el costo
// (`costRealUsd`) junto con ella — el margen mentiría.
//
// Cada línea se trata según dónde esté:
//
//   libre      Nunca se compró (sin costo real y todavía 'pendiente'): se puede cambiar todo,
//              quitar o agregar. Es lo normal de un cambio de último momento.
//   comprada   Ya se compró pero no llegó al cliente: el PRECIO se puede cambiar (es un
//              acuerdo con el cliente, no tiene que ver con la compra) y la cantidad se puede
//              BAJAR — las unidades de más ya existen y pasan a stock propio con su costo
//              (ver `sobrante`). No se puede subir la cantidad (esas unidades no se compraron:
//              hay que pedirlas aparte) ni cambiar qué piezas lleva un conjunto.
//   entregada  Ya se le entregó: no se toca. Lo que falle después es un reclamo, no una edición.
import { claveLinea } from '@/lib/linea-pedido'
import { isDelivered } from '@/lib/shipping-status'

export interface LineaActual {
  id: number
  productId: number | null
  ensambleId: number | null
  quantity: number
  salePrice: number
  bundleItems: unknown
  shippingStatus: string
  costRealUsd: number | null
  nombre: string
  /** Servida con lo del depósito (lib/venta-stock.ts): se devuelve al depósito antes de cambiarla. */
  desdeStock?: boolean
}

export interface LineaNueva {
  /** Cómo se llama, solo para el historial: una línea nueva todavía no tiene fila de la que leerlo. */
  nombre?: string
  productId: number | null
  ensambleId: number | null
  quantity: number
  salePrice: number
  bundleItems: unknown
}

export type EstadoLinea = 'libre' | 'comprada' | 'entregada'

export function estadoLinea(l: Pick<LineaActual, 'shippingStatus' | 'costRealUsd'>): EstadoLinea {
  if (isDelivered(l.shippingStatus)) return 'entregada'
  return l.costRealUsd != null || l.shippingStatus !== 'pendiente' ? 'comprada' : 'libre'
}

// Qué se puede hacer con una línea, dicho para la pantalla (la línea se muestra bloqueada o
// con la cantidad acotada) y para el server (que lo vuelve a verificar).
export interface Permiso {
  estado: EstadoLinea
  /** Cantidad máxima que admite: las ya compradas no suben de lo que se compró. null = sin tope. */
  cantidadMaxima: number | null
  /** Se puede cambiar qué piezas lleva el conjunto. */
  puedeCambiarConjunto: boolean
  puedeCambiarPrecio: boolean
  puedeQuitar: boolean
  /** Por qué está acotada, para mostrarlo. null = sin restricciones. */
  nota: string | null
}

export function permisoDeLinea(l: Pick<LineaActual, 'shippingStatus' | 'costRealUsd' | 'quantity' | 'desdeStock'>): Permiso {
  const estado = estadoLinea(l)
  if (estado === 'comprada' && l.desdeStock) {
    return {
      estado,
      cantidadMaxima: l.quantity,
      puedeCambiarConjunto: false,
      puedeCambiarPrecio: true,
      puedeQuitar: false,
      nota: MSG_DESDE_STOCK,
    }
  }
  if (estado === 'libre') {
    return { estado, cantidadMaxima: null, puedeCambiarConjunto: true, puedeCambiarPrecio: true, puedeQuitar: true, nota: null }
  }
  if (estado === 'comprada') {
    return {
      estado,
      cantidadMaxima: l.quantity,
      puedeCambiarConjunto: false,
      puedeCambiarPrecio: true,
      puedeQuitar: true,
      nota: 'Ya se compró: podés bajar la cantidad (las unidades de más pasan a stock propio) o cambiar el precio, no pedir más.',
    }
  }
  return {
    estado,
    cantidadMaxima: l.quantity,
    puedeCambiarConjunto: false,
    puedeCambiarPrecio: false,
    puedeQuitar: false,
    nota: 'Ya se entregó: no se edita. Si hay un problema con la pieza, anotá un reclamo.',
  }
}

const MSG_DESDE_STOCK = 'Se sirvió con lo del depósito: para quitarla o cambiar la cantidad, devolvela al depósito desde la ficha del pedido.'

export type OpLinea =
  | { op: 'crear'; nueva: LineaNueva }
  // Nunca se compró: se reescribe lo comercial (y la cantidad/precio/conjunto que haya cambiado).
  | { op: 'actualizar'; actual: LineaActual; nueva: LineaNueva }
  // Nunca se compró y el usuario la sacó.
  | { op: 'quitar'; actual: LineaActual }
  // Ya comprada: `unidades` pasan a stock propio. Con `nueva` la línea queda con su nueva cantidad
  // (y quizá otro precio); sin ella la línea sale del pedido entera.
  | { op: 'sobrante'; actual: LineaActual; unidades: number; nueva: LineaNueva | null }
  // Ya comprada, solo cambia el precio.
  | { op: 'precio'; actual: LineaActual; nueva: LineaNueva }

const centavos = (n: number) => Math.round(n * 100) / 100

// Compara dos snapshots de conjunto sin importar el orden de las claves.
function mismoConjunto(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)]))
        : v
  return JSON.stringify(norm(a ?? null)) === JSON.stringify(norm(b ?? null))
}

export interface PlanEdicion {
  ops: OpLinea[]
  error: string | null
}

// Cruza lo que hay con lo que el usuario dejó y decide qué se hace con cada línea, o por qué no
// se puede. No toca nada: el server aplica las operaciones, la pantalla puede ensayarlas.
export function planEdicion(actuales: LineaActual[], nuevas: LineaNueva[]): PlanEdicion {
  const porClave = new Map(nuevas.map(n => [claveLinea(n), n]))
  const ops: OpLinea[] = []
  const rechazo = (error: string): PlanEdicion => ({ ops: [], error })

  for (const a of actuales) {
    const n = porClave.get(claveLinea(a)) ?? null
    const estado = estadoLinea(a)

    if (estado === 'entregada') {
      if (!n) return rechazo(`«${a.nombre}» ya se entregó: no se puede sacar del pedido. Si el cliente la devolvió o vino mal, anotá un reclamo.`)
      if (n.quantity !== a.quantity || centavos(n.salePrice) !== centavos(a.salePrice) || !mismoConjunto(n.bundleItems, a.bundleItems)) {
        return rechazo(`«${a.nombre}» ya se entregó: no se puede cambiar. Si hay un problema con la pieza, anotá un reclamo.`)
      }
      continue
    }

    if (estado === 'libre') {
      if (!n) { ops.push({ op: 'quitar', actual: a }); continue }
      const igual =
        n.quantity === a.quantity && centavos(n.salePrice) === centavos(a.salePrice) && mismoConjunto(n.bundleItems, a.bundleItems)
      if (!igual) ops.push({ op: 'actualizar', actual: a, nueva: n })
      continue
    }

    // Servida con lo del depósito: sus unidades salieron del stock. Bajarlas o quitarla mandaría el
    // sobrante a un stock propio que no viaja en ninguna caja; se devuelve al depósito primero.
    if (a.desdeStock) {
      if (!n || n.quantity !== a.quantity) return rechazo(`«${a.nombre}»: ${MSG_DESDE_STOCK}`)
      if (centavos(n.salePrice) !== centavos(a.salePrice)) ops.push({ op: 'precio', actual: a, nueva: n })
      continue
    }

    // comprada, todavía no entregada
    if (!n) {
      ops.push({ op: 'sobrante', actual: a, unidades: a.quantity, nueva: null })
      continue
    }
    if (n.quantity > a.quantity) {
      return rechazo(
        `«${a.nombre}» ya se compró (${a.quantity}): no se puede subir a ${n.quantity}. ` +
        `Las unidades de más no se pidieron al proveedor; pedilas en un pedido aparte.`,
      )
    }
    if (!mismoConjunto(n.bundleItems, a.bundleItems)) {
      return rechazo(`«${a.nombre}» ya se compró: no se puede cambiar qué piezas lleva el conjunto.`)
    }
    if (n.quantity < a.quantity) {
      ops.push({ op: 'sobrante', actual: a, unidades: a.quantity - n.quantity, nueva: n })
    } else if (centavos(n.salePrice) !== centavos(a.salePrice)) {
      ops.push({ op: 'precio', actual: a, nueva: n })
    }
  }

  const actualesClaves = new Set(actuales.map(claveLinea))
  for (const n of nuevas) {
    if (!actualesClaves.has(claveLinea(n))) ops.push({ op: 'crear', nueva: n })
  }
  return { ops, error: null }
}

// Un pedido SIN cliente confirmado (stock propio, o un presupuesto metido en una caja) no tiene
// adónde mandar lo que sobra: ya es lo mío. Así que una línea comprada queda fija salvo el
// precio — quitarla o bajarle unidades borraba su costo pagado; subirlas pedía lo que no se
// compró. Lo entregado de un propio sí se edita (ajusta el stock, ver updatePresupuesto).
export function permisoSinCliente(l: Pick<LineaActual, 'shippingStatus' | 'costRealUsd' | 'quantity'>): Permiso | undefined {
  if (estadoLinea(l) !== 'comprada') return undefined
  return {
    estado: 'comprada',
    cantidadMaxima: l.quantity,
    puedeCambiarConjunto: false,
    puedeCambiarPrecio: true,
    puedeQuitar: false,
    nota: 'Ya se compró: solo se le cambia el precio. Para deshacer la compra, borrá su pago en Contabilidad.',
  }
}

export function motivoEdicionSinCliente(actuales: LineaActual[], nuevas: LineaNueva[]): string | null {
  const porClave = new Map(nuevas.map(n => [claveLinea(n), n]))
  for (const a of actuales) {
    if (!permisoSinCliente(a)) continue
    const n = porClave.get(claveLinea(a))
    if (!n) return `«${a.nombre}» ya se compró: no se puede quitar.`
    if (n.quantity !== a.quantity) return `«${a.nombre}» ya se compró (${a.quantity}): no se le cambia la cantidad.`
    if (!mismoConjunto(n.bundleItems, a.bundleItems)) return `«${a.nombre}» ya se compró: no se cambia qué piezas lleva el conjunto.`
  }
  return null
}

// Cómo se reparte el costo de una línea comprada cuando parte de sus unidades pasa a stock: el
// costo viaja con las unidades (prorrateado por cantidad) y lo que queda en la línea es el resto
// EXACTO — nunca dos redondeos que sumen un centavo de más o de menos.
export function repartirSobrante(
  costRealUsd: number | null,
  cantidad: number,
  unidades: number,
): { sobranteUsd: number | null; quedaUsd: number | null } {
  if (costRealUsd == null) return { sobranteUsd: null, quedaUsd: null }
  const sobranteUsd = centavos((costRealUsd * unidades) / cantidad)
  return { sobranteUsd, quedaUsd: centavos(costRealUsd - sobranteUsd) }
}

// Una línea de texto por cambio, para el historial del pedido.
export function describirOps(ops: OpLinea[]): string[] {
  const usd = (n: number) => `$${n.toFixed(2)}`
  const out: string[] = []
  for (const o of ops) {
    switch (o.op) {
      case 'crear':
        out.push(`Agregó ${o.nueva.quantity}× «${o.nueva.nombre ?? 'una pieza'}» a ${usd(o.nueva.salePrice)}`)
        break
      case 'quitar':
        out.push(`Quitó «${o.actual.nombre}» (${o.actual.quantity}×)`)
        break
      case 'actualizar': {
        const partes: string[] = []
        if (o.nueva.quantity !== o.actual.quantity) partes.push(`cantidad ${o.actual.quantity} → ${o.nueva.quantity}`)
        if (centavos(o.nueva.salePrice) !== centavos(o.actual.salePrice)) partes.push(`precio ${usd(o.actual.salePrice)} → ${usd(o.nueva.salePrice)}`)
        if (!mismoConjunto(o.nueva.bundleItems, o.actual.bundleItems)) partes.push('piezas del conjunto')
        out.push(`«${o.actual.nombre}»: ${partes.join(', ')}`)
        break
      }
      case 'precio':
        out.push(`«${o.actual.nombre}»: precio ${usd(o.actual.salePrice)} → ${usd(o.nueva.salePrice)}`)
        break
      case 'sobrante':
        out.push(
          o.nueva
            ? `«${o.actual.nombre}»: cantidad ${o.actual.quantity} → ${o.nueva.quantity} (${o.unidades} ya comprada${o.unidades === 1 ? '' : 's'} pasa${o.unidades === 1 ? '' : 'n'} a stock propio)`
            : `Quitó «${o.actual.nombre}» ya comprada (${o.unidades}× pasa${o.unidades === 1 ? '' : 'n'} a stock propio)`,
        )
        break
    }
  }
  return out
}
