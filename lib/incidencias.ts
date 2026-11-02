// Lo que le pasa a una línea fuera del camino feliz (puro, sin DB).
//
// El recorrido de una línea (lib/shipping-status.ts) solo sabía avanzar: no tenía "no disponible",
// "llegó dañada", "perdida", "incompleta" ni "pieza equivocada", y si llegaban 3 de 5 no había
// dónde anotarlo. Tampoco había dónde registrar un reclamo del cliente, aunque los términos le
// prometen 48 horas para hacerlo. Todo eso es lo mismo —una cantidad de unidades de una línea
// que no salió como se esperaba— y se anota igual: una Incidencia.
//
// Una incidencia se anota (queda ABIERTA) y se RESUELVE de una de cinco maneras. Lo que importa
// es lo que cada manera hace con la plata, que es por lo que esto no es solo una nota:
//
//   llego        Era una falsa alarma o apareció después. No pasa nada con la plata.
//   sustituida   (solo "no disponible") Se cambió o se quitó la pieza editando el pedido.
//   rechazado    (solo reclamos) No procede: instalada, fuera de plazo, uso indebido.
//   reposicion   Se vuelve a mandar. Nace un pedido nuevo a $0 con esas unidades: lo que cuesta
//                comprarlas otra vez queda como margen negativo de ESE pedido, y el costo de lo
//                que se perdió sigue en el original. Entre los dos pedidos el costo cierra.
//   reembolso    Se le devuelve al cliente. Las unidades salen del pedido (baja lo vendido) y
//                lo que ya se había pagado por ellas queda como PÉRDIDA del pedido: la línea no
//                puede seguir cargando un costo de piezas que no se entregan sin que el margen
//                lo diga.
//
// Una incidencia abierta frena lo que no debe seguir: no se compra una pieza "no disponible" y no
// se entrega una línea con algo sin resolver.
import { estadoLinea } from '@/lib/pedido-edicion'
import { statusIndex } from '@/lib/shipping-status'

export const TIPOS_INCIDENCIA = ['no_disponible', 'sin_enviar', 'danada', 'perdida', 'faltante', 'equivocada', 'defecto'] as const
export type TipoIncidencia = (typeof TIPOS_INCIDENCIA)[number]

export const RESOLUCIONES = ['llego', 'sustituida', 'rechazado', 'reposicion', 'reembolso'] as const
export type Resolucion = (typeof RESOLUCIONES)[number]

export type OrigenIncidencia = 'operacion' | 'cliente'

export const TIPO_LABELS: Record<TipoIncidencia, string> = {
  no_disponible: 'No disponible',
  sin_enviar: 'El proveedor no la mandó',
  danada: 'Llegó dañada',
  perdida: 'Perdida',
  faltante: 'Llegó incompleta',
  equivocada: 'Pieza equivocada',
  defecto: 'Defecto de fábrica',
}

export const TIPO_AYUDA: Record<TipoIncidencia, string> = {
  no_disponible: 'El proveedor no la tiene o Bajaj la cambió por otro código.',
  sin_enviar: 'Te la vendió (o te la va a vender) pero todavía no la despachó: la caja no la espera al llegar.',
  danada: 'Llegó rota o golpeada.',
  perdida: 'No llegó: se perdió en el camino.',
  faltante: 'Llegaron menos unidades de las compradas.',
  equivocada: 'Llegó otra pieza distinta a la pedida.',
  defecto: 'Falla de fábrica reclamada por el cliente (garantía).',
}

export const RESOLUCION_LABELS: Record<Resolucion, string> = {
  llego: 'Llegó / falsa alarma',
  sustituida: 'Se cambió o quitó del pedido',
  rechazado: 'No procede',
  reposicion: 'Reponer (pedido nuevo a $0)',
  reembolso: 'Reembolsar al cliente',
}

export function esTipoIncidencia(v: string): v is TipoIncidencia {
  return (TIPOS_INCIDENCIA as readonly string[]).includes(v)
}
export function esResolucion(v: string): v is Resolucion {
  return (RESOLUCIONES as readonly string[]).includes(v)
}

// Qué se puede anotar según dónde esté la línea. Antes de comprarla, que no esté disponible o que
// el proveedor no la vaya a mandar con el resto; ya comprada y en camino, lo que le pasa a la
// mercancía (y, mientras no llegó, que el proveedor no la mandó); y entregada, solo lo que reclama
// el cliente (con origen 'cliente').
export function tiposPara(linea: { shippingStatus: string; costRealUsd: number | null }): TipoIncidencia[] {
  switch (estadoLinea(linea)) {
    case 'libre': return ['no_disponible', 'sin_enviar']
    case 'comprada':
      return statusIndex(linea.shippingStatus) < statusIndex('en_venezuela')
        ? ['sin_enviar', 'danada', 'perdida', 'faltante', 'equivocada']
        : ['danada', 'perdida', 'faltante', 'equivocada']
    case 'entregada': return ['danada', 'faltante', 'equivocada', 'defecto']
  }
}

/** En un pedido de stock propio solo se anota lo que el proveedor no mandó (no hay cliente que reclame). */
export function tiposParaPropio(linea: { shippingStatus: string; costRealUsd: number | null }): TipoIncidencia[] {
  return tiposPara(linea).filter(t => t === 'sin_enviar')
}

/** Los tipos que se pueden anotar sobre UNA pieza de un conjunto (el resto es de unidades de la línea). */
export function admitePieza(tipo: TipoIncidencia): boolean {
  return tipo === 'no_disponible' || tipo === 'sin_enviar'
}

export function origenPara(linea: { shippingStatus: string; costRealUsd: number | null }): OrigenIncidencia {
  return estadoLinea(linea) === 'entregada' ? 'cliente' : 'operacion'
}

// Cómo se puede cerrar según qué es, quién lo detectó y de qué pedido es. En stock propio no hay
// cliente a quien reponerle: lo que el proveedor no mandó llega después o te lo reembolsa.
export function resolucionesPara(tipo: TipoIncidencia, origen: OrigenIncidencia, propio = false): Resolucion[] {
  if (tipo === 'no_disponible') return ['llego', 'sustituida']
  if (propio) return tipo === 'sin_enviar' ? ['llego', 'reembolso'] : []
  if (origen === 'cliente') return ['reposicion', 'reembolso', 'rechazado']
  return tipo === 'danada' || tipo === 'equivocada'
    ? ['reposicion', 'reembolso', 'llego']
    : ['llego', 'reposicion', 'reembolso']
}

export interface IncidenciaAbierta {
  tipo: string
  estado: string
}

const abiertas = (l: IncidenciaAbierta[]) => l.filter(i => i.estado === 'abierta')

// No se entrega una línea con algo sin resolver (una dañada, una incompleta), ni se compra una
// "no disponible".
export function bloqueaEntrega(l: IncidenciaAbierta[]): boolean {
  return abiertas(l).length > 0
}
export function bloqueaCompra(l: IncidenciaAbierta[]): boolean {
  return abiertas(l).some(i => i.tipo === 'no_disponible')
}

// ── Lo que el proveedor no mandó ─────────────────────────────────────────────────────────────
// El proveedor vende el pedido pero alguna pieza la despacha después (backorder). Se anota desde
// la compra como "sin_enviar" y, mientras esté abierta, la caja no la espera: el conteo no la pide
// y "Marcar recibido" no pasa a Recibido una línea que no vino entera. Cuando llega se cierra como
// "llego"; si nunca llega, como reembolso o reposición, igual que un faltante.

export interface SinEnviar {
  /** Unidades de la línea (sets, si es un conjunto) que no vinieron enteras. */
  lineaEntera: number
  /** En un conjunto: unidades de cada pieza (por etiquetaPieza) que no vinieron. */
  porPieza: Map<string, number>
}

export function sinEnviarDe(incidencias: { tipo: string; estado: string; cantidad: number; pieza: string | null }[]): SinEnviar {
  const s: SinEnviar = { lineaEntera: 0, porPieza: new Map() }
  for (const i of incidencias) {
    if (i.tipo !== 'sin_enviar' || i.estado !== 'abierta') continue
    if (i.pieza == null) s.lineaEntera += i.cantidad
    else s.porPieza.set(i.pieza, (s.porPieza.get(i.pieza) ?? 0) + i.cantidad)
  }
  return s
}

/** Cómo se dice en una etiqueta: "2 sin enviar", "1 pieza sin enviar"; null si vino todo. */
export function textoSinEnviar(s: SinEnviar): string | null {
  const piezas = [...s.porPieza.values()].reduce((a, b) => a + b, 0)
  const partes = [
    s.lineaEntera > 0 ? `${s.lineaEntera}` : null,
    piezas > 0 ? `${piezas} ${piezas === 1 ? 'pieza' : 'piezas'}` : null,
  ].filter(Boolean)
  return partes.length > 0 ? `${partes.join(' + ')} sin enviar` : null
}

/** La línea no viene en la caja: el proveedor no mandó ninguna de sus unidades. No se recibe. */
export function lineaNoViene(quantity: number, s: SinEnviar): boolean {
  return s.lineaEntera >= quantity
}

// ── Una pieza de un conjunto ─────────────────────────────────────────────────────────────────
// Un conjunto se compra entero pero casi nunca falla entero: falta UN SKU. Se anota cuál, y editar
// el pedido quitando esa pieza cierra el problema solo (no hay que ir a resolverlo a mano).

/** Cómo se nombra una pieza de un conjunto: sirve para mostrarla y para reconocerla después. */
export function etiquetaPieza(p: { nameEs: string; bajajCode: string | null }): string {
  return p.bajajCode ? `${p.nameEs} (${p.bajajCode})` : p.nameEs
}

/**
 * Entre los "no disponible" abiertos de una línea, los que dejan de serlo porque el conjunto ya no
 * lleva esa pieza. Los que son de la línea entera (`pieza` null) no se tocan: esos se cierran
 * sacando la línea o a mano.
 */
export function cerradosPorEdicion(
  abiertas: { id: number; tipo: string; pieza: string | null }[],
  piezasNuevas: { nameEs: string; bajajCode: string | null }[],
): number[] {
  const quedan = new Set(piezasNuevas.map(etiquetaPieza))
  return abiertas
    .filter(i => i.tipo === 'no_disponible' && i.pieza != null && !quedan.has(i.pieza))
    .map(i => i.id)
}

const centavos = (n: number) => Math.round(n * 100) / 100

// Lo que cuestan N unidades de una línea comprada: su costo prorrateado por cantidad. Es la
// pérdida que se propone al reembolsar; se puede cambiar (si el proveedor devolvió parte).
export function perdidaSugerida(costRealUsd: number | null, cantidadLinea: number, unidades: number): number {
  if (costRealUsd == null || cantidadLinea <= 0) return 0
  return centavos((costRealUsd * unidades) / cantidadLinea)
}

// Al reembolsar algo que el proveedor no mandó, lo que él te devolvió ya no es pérdida: se pierde
// solo lo que pagaste por esas unidades y no volvió.
export function perdidaTrasDevolucion(costoUnidadesUsd: number, devueltoProveedorUsd: number): number {
  return centavos(Math.max(0, costoUnidadesUsd - devueltoProveedorUsd))
}

export interface LineaParaResolver {
  quantity: number
  salePrice: number
  costRealUsd: number | null
}

// Lo que pasa con la línea al reembolsar `unidades`: baja la cantidad (y con ella lo vendido),
// el costo de esas unidades sale de la línea y entra al pedido como pérdida. `quitaLinea` = se
// reembolsó todo y la línea ya no tiene nada que mostrar.
export function planReembolso(linea: LineaParaResolver, unidades: number, perdidaUsd: number) {
  const quedan = linea.quantity - unidades
  const costoQueSale = linea.costRealUsd != null ? perdidaSugerida(linea.costRealUsd, linea.quantity, unidades) : 0
  return {
    quedan,
    quitaLinea: quedan <= 0,
    costRealNuevo: linea.costRealUsd != null ? centavos(linea.costRealUsd - costoQueSale) : null,
    perdidaUsd: centavos(perdidaUsd),
    // Lo que deja de deberle el cliente por esas unidades.
    bajaVentaUsd: centavos(linea.salePrice * unidades),
  }
}

// Mensaje de por qué no se puede resolver así, o null.
export function motivoResolucionInvalida(i: {
  tipo: TipoIncidencia
  origen: OrigenIncidencia
  cantidad: number
  resolucion: Resolucion
  linea: LineaParaResolver | null
  perdidaUsd: number | null
  /** Pedido de stock propio. */
  propio?: boolean
  /** Lo que devolvió el proveedor (solo al reembolsar algo que no mandó). null = no se escribió. */
  devueltoProveedorUsd?: number | null
  /** La pieza del conjunto, si la incidencia es de una sola (null = la línea entera). */
  pieza?: string | null
}): string | null {
  if (!resolucionesPara(i.tipo, i.origen, i.propio).includes(i.resolucion)) {
    return `Un problema «${TIPO_LABELS[i.tipo]}» no se puede cerrar como «${RESOLUCION_LABELS[i.resolucion]}».`
  }
  if (i.resolucion === 'reposicion' || i.resolucion === 'reembolso') {
    if (!i.linea) return 'La línea ya no está en el pedido: no hay de dónde reponer o reembolsar.'
    // Reponer o reembolsar baja sets enteros: una sola pieza de un conjunto no se puede descontar así.
    if (i.pieza) return 'Una pieza suelta de un conjunto no se repone ni se reembolsa sola: cerrala y anotá el problema sobre el conjunto entero.'
    if (i.cantidad > i.linea.quantity) {
      return `La incidencia es de ${i.cantidad} unidades pero la línea tiene ${i.linea.quantity}.`
    }
  }
  if (i.resolucion === 'reembolso' && i.perdidaUsd != null && (!Number.isFinite(i.perdidaUsd) || i.perdidaUsd < 0)) {
    return 'La pérdida no es un monto válido.'
  }
  if (i.resolucion === 'reembolso' && i.tipo === 'sin_enviar') {
    const d = i.devueltoProveedorUsd
    if (d == null) return 'Escribí cuánto te devolvió el proveedor (0 si no te devolvió nada).'
    if (!Number.isFinite(d) || d < 0) return 'Lo que devolvió el proveedor no es un monto válido.'
  }
  return null
}

// ¿Está dentro del plazo que los términos dan para reclamar? `entregadoAt` es cuándo se marcó la
// línea como entregada. Sin fecha no se puede decir que se pasó: se acepta.
export function dentroDePlazo(entregadoAt: Date | null, horas: number, ahora: Date = new Date()): boolean {
  if (!entregadoAt) return true
  return ahora.getTime() - entregadoAt.getTime() <= horas * 3600 * 1000
}

export const RECLAMO_HORAS_DEFAULT = 48
