import type { BundlePiece } from './bundle'
import { etiquetaPieza, type SinEnviar } from './incidencias'
import { statusIndex } from './shipping-status'

// Reglas de la recepción de una caja (docs/plan-inventario/03-recepcion.md), puras: las usan la
// pantalla (que esconde el botón) y lib/recepcion-db.ts (el candado real), y check:costeo.
//
// Una recepción cuenta por CÓDIGO (la fila de la mesa) y el cierre reparte lo contado entre las
// LÍNEAS de pedido que lo esperaban. Lo que esperaba cada línea sale de su estado, no de restar
// conteos anteriores: una línea antes de en_venezuela espera todo lo que trae (menos lo que el
// proveedor avisó que no mandó); una que ya llegó espera solo su backorder, las sin_enviar que dejó
// una recepción anterior. Así las cajas recibidas antes de que existiera esto no piden conteo.

export const DECISIONES = ['backorder', 'faltante', 'equivocada'] as const
export type Decision = (typeof DECISIONES)[number]
export const esDecision = (v: string): v is Decision => (DECISIONES as readonly string[]).includes(v)

export const DECISION_LABEL: Record<Decision, string> = {
  backorder: 'Llega después',
  faltante: 'No va a llegar',
  equivocada: 'Llegó otra en su lugar',
}

/** La clave de una fila de la mesa: el código, o el nombre si la pieza no tiene. */
export const claveDe = (codigo: string | null, nombre: string) => codigo?.trim() || nombre

export interface PiezaLinea extends BundlePiece {
  productId: number | null
}

// Una línea de pedido que viaja en la caja (aéreo), con lo que hace falta para saber qué espera.
export interface LineaCaja {
  itemId: number
  pedidoId: number
  propio: boolean
  /** Antigüedad del pedido (createdAt en ms): el reparto cubre primero al más viejo. */
  orden: number
  shippingStatus: string
  quantity: number
  nombre: string
  codigo: string | null
  productId: number | null
  /** Vacío = pieza suelta. */
  piezas: PiezaLinea[]
  /** sin_enviar abiertas que anotó el dueño (el proveedor avisó): no se esperan. */
  sinEnviarManual: SinEnviar
  /** sin_enviar abiertas que dejó una recepción (backorder): se esperan en la siguiente. */
  sinEnviarRecepcion: SinEnviar
}

export interface PiezaPendiente {
  clave: string
  codigo: string | null
  nombre: string
  productId: number | null
  /** En un conjunto, etiquetaPieza de la pieza; null en una pieza suelta. */
  etiqueta: string | null
  unidades: number
}

const llego = (status: string) => statusIndex(status) >= statusIndex('en_venezuela')

// Lo que UNA línea espera recibir en esta recepción, por pieza física.
export function pendienteDeLinea(l: LineaCaja): PiezaPendiente[] {
  const ya = llego(l.shippingStatus)
  const s = ya ? l.sinEnviarRecepcion : l.sinEnviarManual
  const sets = Math.min(l.quantity, s.lineaEntera)
  if (l.piezas.length === 0) {
    const u = ya ? sets : l.quantity - sets
    return u > 0 ? [{ clave: claveDe(l.codigo, l.nombre), codigo: l.codigo, nombre: l.nombre, productId: l.productId, etiqueta: null, unidades: u }] : []
  }
  const m = new Map<string, PiezaPendiente>()
  for (const p of l.piezas) {
    const e = etiquetaPieza(p)
    const deLaPieza = p.quantity * sets + (s.porPieza.get(e) ?? 0)
    const u = Math.max(0, ya ? deLaPieza : p.quantity * l.quantity - deLaPieza)
    const prev = m.get(e)
    if (prev) prev.unidades += u
    else m.set(e, { clave: claveDe(p.bajajCode, p.nameEs), codigo: p.bajajCode, nombre: p.nameEs, productId: p.productId, etiqueta: e, unidades: u })
  }
  return [...m.values()].filter(p => p.unidades > 0)
}

export interface FilaEsperada {
  codigo: string
  nombre: string
  productId: number | null
  esperado: number
}

/** Una fila de una recepción anterior (cerrada y no revertida) de la misma caja. */
export interface FilaAnterior {
  codigo: string | null
  esperado: number
  contado: number | null
  decision: string | null
}

// Las filas de la mesa: lo pendiente sumado por código, menos lo que ya resolvieron recepciones
// anteriores (lo que el marítimo necesita: sus líneas no tienen etapa). Una fila anterior resolvió
// lo que contó, y todo lo que esperaba salvo que lo faltante haya quedado en backorder.
export function esperadoDeRecepcion(pendientes: PiezaPendiente[], anteriores: FilaAnterior[] = []): FilaEsperada[] {
  const m = new Map<string, FilaEsperada>()
  for (const p of pendientes) {
    const f = m.get(p.clave)
    if (f) { f.esperado += p.unidades; f.productId ??= p.productId }
    else m.set(p.clave, { codigo: p.clave, nombre: p.nombre, productId: p.productId, esperado: p.unidades })
  }
  for (const a of anteriores) {
    const f = a.codigo != null ? m.get(a.codigo) : undefined
    if (!f) continue
    f.esperado -= a.decision === 'backorder' ? Math.min(a.contado ?? 0, a.esperado) : a.esperado
  }
  return [...m.values()].filter(f => f.esperado > 0).sort((a, b) => a.nombre.localeCompare(b.nombre))
}

export interface CoberturaPieza extends PiezaPendiente {
  cubierto: number
}
export interface CoberturaLinea {
  linea: LineaCaja
  piezas: CoberturaPieza[]
}
export interface Reparto {
  lineas: CoberturaLinea[]
  /** Por clave: lo contado de más sobre lo que esperaban todas las líneas. */
  sobrante: Map<string, number>
}

// Qué líneas quedan cubiertas con lo contado. Lo que falta lo absorbe primero el stock propio y
// después el pedido de cliente más nuevo: el cliente que más espera es el último sin su pieza.
const ordenReparto = (lineas: LineaCaja[]) =>
  [...lineas].sort((a, b) => Number(a.propio) - Number(b.propio) || a.orden - b.orden || a.itemId - b.itemId)

export function repartirConteo(lineas: LineaCaja[], contado: Map<string, number>): Reparto {
  const queda = new Map(contado)
  const cob = ordenReparto(lineas).map(linea => ({
    linea,
    piezas: pendienteDeLinea(linea).map(p => {
      const hay = queda.get(p.clave) ?? 0
      const cubierto = Math.min(hay, p.unidades)
      queda.set(p.clave, hay - cubierto)
      return { ...p, cubierto }
    }),
  })).filter(c => c.piezas.length > 0)
  return { lineas: cob, sobrante: new Map([...queda].filter(([, n]) => n > 0)) }
}

// A quién van las unidades (desde, hasta] de una clave recién leídas, en el mismo orden que el
// reparto del cierre: así separar al escanear coincide con lo que el cierre le asigna a cada pedido.
// pedidoId null = stock (lo propio y lo que sobra).
export function destinoDeUnidades(lineas: LineaCaja[], clave: string, desde: number, hasta: number): { pedidoId: number | null; unidades: number }[] {
  const out = new Map<number | null, number>()
  const sumar = (k: number | null, n: number) => { if (n > 0) out.set(k, (out.get(k) ?? 0) + n) }
  let acum = 0
  for (const l of ordenReparto(lineas)) {
    for (const p of pendienteDeLinea(l)) {
      if (p.clave !== clave) continue
      sumar(l.propio ? null : l.pedidoId, Math.min(hasta, acum + p.unidades) - Math.max(desde, acum))
      acum += p.unidades
    }
  }
  sumar(null, hasta - Math.max(desde, acum))
  return [...out].map(([pedidoId, unidades]) => ({ pedidoId, unidades }))
}

/** Una fila de la recepción, tal como está en la base. */
export interface FilaRecepcion {
  codigo: string | null
  productId: number | null
  nombre: string
  esperado: number
  contado: number | null
  decision: string | null
}

// Cómo quedó una fila: lo que el aviso de cada lectura dice en voz alta (pasarse no es silencioso).
//   sin_contar   nadie la contó todavía (vacío no es cero)
//   falta        contada por debajo de lo esperado (0 = la busqué y no está)
//   completa     llegó justo lo esperado
//   sobra        llegó más de lo esperado: lo de más entra como sobrante al cerrar
//   no_esperada  no venía en la caja (esperado 0): anotada a propósito
export type EstadoFila = 'sin_contar' | 'falta' | 'completa' | 'sobra' | 'no_esperada'
export function estadoFila(contado: number | null, esperado: number): EstadoFila {
  if (esperado === 0) return 'no_esperada'
  if (contado == null) return 'sin_contar'
  return contado < esperado ? 'falta' : contado === esperado ? 'completa' : 'sobra'
}

// El progreso de la caja en piezas (no en códigos): cuántas de las esperadas ya están, cuántas
// faltan y cuántas sobran (lo contado de más y lo no esperado). Una fila sin contar falta entera.
export function progresoRecepcion(filas: Pick<FilaRecepcion, 'esperado' | 'contado'>[]) {
  let esperadas = 0, contadas = 0, faltan = 0, sobran = 0, sinContar = 0
  for (const f of filas) {
    const n = f.contado ?? 0
    esperadas += f.esperado
    contadas += Math.min(n, f.esperado)
    faltan += Math.max(0, f.esperado - n)
    sobran += Math.max(0, n - f.esperado)
    if (f.contado == null) sinContar++
  }
  return { esperadas, contadas, faltan, sobran, sinContar }
}

// Por qué no se puede cerrar todavía, o null. Una fila sin pieza del catálogo (código desconocido o
// sin identificar) contada en 0 está descartada y no frena.
export function puedeCerrar(filas: FilaRecepcion[]): string | null {
  if (filas.length === 0) return 'No hay nada que contar en esta recepción.'
  const sinContar = filas.filter(f => f.contado == null).length
  if (sinContar > 0) return `Faltan ${sinContar} ${sinContar === 1 ? 'código' : 'códigos'} por contar (0 si no llegó).`
  const sinId = filas.filter(f => f.codigo == null && f.contado! > 0).length
  if (sinId > 0) return `${sinId === 1 ? 'Hay una pieza sin identificar' : `Hay ${sinId} piezas sin identificar`}: asignala a una pieza o descartala.`
  const fuera = filas.filter(f => f.codigo != null && f.productId == null && f.contado! > 0)
  if (fuera.length > 0) return `${fuera.map(f => f.codigo).slice(0, 3).join(', ')} no ${fuera.length === 1 ? 'está' : 'están'} en el catálogo: creá la pieza o descartala.`
  const sinDecidir = filas.filter(f => f.contado! < f.esperado && (f.decision == null || !esDecision(f.decision))).length
  if (sinDecidir > 0) return `Decidí qué pasa con lo que faltó en ${sinDecidir} ${sinDecidir === 1 ? 'código' : 'códigos'}.`
  return null
}

export interface MovPlan {
  productId: number
  cantidad: number
  motivo: 'recepcion' | 'sobrante_recepcion'
  costoUnitUsd: number | null
  pedidoId?: number
  pedidoItemId?: number
}
export interface IncidenciaPlan {
  pedidoId: number
  itemId: number
  descripcion: string
  pieza: string | null
  tipo: 'sin_enviar' | 'faltante' | 'equivocada'
  cantidad: number
}
export interface PlanCierre {
  etapas: { itemId: number; desde: string; hacia: string }[]
  stock: MovPlan[]
  incidencias: IncidenciaPlan[]
  /** Líneas cuyas sin_enviar de recepciones anteriores (el backorder que se esperaba) se cierran como 'llego'. */
  backordersCerrados: number[]
}

const TIPO_DE: Record<Decision, IncidenciaPlan['tipo']> = { backorder: 'sin_enviar', faltante: 'faltante', equivocada: 'equivocada' }

// Todo lo que el cierre va a escribir, sin tocar la base. Exige puedeCerrar(filas) === null.
//   aéreo     reparto por línea: cliente cubierto → en_venezuela; propio → entregado con stock por
//             lo cubierto; lo que falta según la decisión de su fila (backorder → sin_enviar,
//             faltante/equivocada → su incidencia; en propio no hay incidencia: la diferencia
//             queda en la recepción). Una línea que no recibió nada y todo en backorder no se mueve.
//   marítimo  stock por lo contado hasta lo esperado, al landed de la caja. Sin incidencias.
//   los dos   lo contado de más entra como sobrante a $0 (regalo del proveedor).
export function planCierre(
  filas: FilaRecepcion[],
  caja: { modo: 'aereo'; lineas: LineaCaja[] } | { modo: 'maritimo'; costoUnit: Map<number, number | null> },
): PlanCierre {
  const plan: PlanCierre = { etapas: [], stock: [], incidencias: [], backordersCerrados: [] }
  const porClave = new Map(filas.flatMap(f => (f.codigo != null ? [[f.codigo, f] as const] : [])))
  const sobrante = (productId: number | null, n: number) => {
    if (productId != null && n > 0) plan.stock.push({ productId, cantidad: n, motivo: 'sobrante_recepcion', costoUnitUsd: 0 })
  }

  if (caja.modo === 'maritimo') {
    for (const f of filas) {
      if (f.productId == null || !f.contado) continue
      const entra = Math.min(f.contado, f.esperado)
      if (entra > 0) plan.stock.push({ productId: f.productId, cantidad: entra, motivo: 'recepcion', costoUnitUsd: caja.costoUnit.get(f.productId) ?? null })
      sobrante(f.productId, f.contado - entra)
    }
    return plan
  }

  const contado = new Map(filas.flatMap(f => (f.codigo != null && f.contado ? [[f.codigo, f.contado] as const] : [])))
  const reparto = repartirConteo(caja.lineas, contado)
  for (const [clave, n] of reparto.sobrante) sobrante(porClave.get(clave)?.productId ?? null, n)

  for (const { linea: l, piezas } of reparto.lineas) {
    if (l.sinEnviarRecepcion.lineaEntera > 0 || l.sinEnviarRecepcion.porPieza.size > 0) plan.backordersCerrados.push(l.itemId)
    const decisionDe = (p: CoberturaPieza): Decision => {
      const d = porClave.get(p.clave)?.decision
      return d != null && esDecision(d) ? d : 'faltante'
    }
    const cortas = piezas.filter(p => p.cubierto < p.unidades)

    if (l.propio) {
      for (const p of piezas) {
        const productId = porClave.get(p.clave)?.productId ?? p.productId
        if (p.cubierto > 0 && productId != null) {
          plan.stock.push({ productId, cantidad: p.cubierto, motivo: 'recepcion', costoUnitUsd: null, pedidoId: l.pedidoId, pedidoItemId: l.itemId })
        }
      }
    }

    // Lo que falta, como incidencia. Un conjunto del que no llegó nada, con la misma decisión en
    // todas sus piezas y en sets enteros, es UNA incidencia de la línea (así se recibe o reembolsa entero).
    const conIncidencia = cortas.filter(p => !l.propio || decisionDe(p) === 'backorder')
    const d0 = conIncidencia[0] ? decisionDe(conIncidencia[0]) : null
    const sets = l.piezas.length > 0 && conIncidencia.length === piezas.length && d0 != null
      ? setsEnteros(l, conIncidencia, d0, decisionDe)
      : null
    if (sets != null) {
      plan.incidencias.push({ pedidoId: l.pedidoId, itemId: l.itemId, descripcion: l.nombre, pieza: null, tipo: TIPO_DE[d0!], cantidad: sets })
    } else {
      for (const p of conIncidencia) {
        plan.incidencias.push({ pedidoId: l.pedidoId, itemId: l.itemId, descripcion: l.nombre, pieza: p.etiqueta, tipo: TIPO_DE[decisionDe(p)], cantidad: p.unidades - p.cubierto })
      }
    }

    // Se mueve si recibió algo o si lo que falta no se espera más; todo en backorder la deja donde está.
    const seMueve = piezas.some(p => p.cubierto > 0) || cortas.some(p => decisionDe(p) !== 'backorder')
    if (seMueve && !llego(l.shippingStatus)) {
      plan.etapas.push({ itemId: l.itemId, desde: l.shippingStatus, hacia: l.propio ? 'entregado' : 'en_venezuela' })
    }
  }
  return plan
}

// Si en todas las piezas de un conjunto no llegó nada y faltan las mismas N unidades del conjunto, N.
function setsEnteros(l: LineaCaja, cortas: CoberturaPieza[], d: Decision, decisionDe: (p: CoberturaPieza) => Decision): number | null {
  let n: number | null = null
  for (const p of cortas) {
    if (p.cubierto > 0 || decisionDe(p) !== d) return null
    const porSet = l.piezas.filter(x => etiquetaPieza(x) === p.etiqueta).reduce((s, x) => s + x.quantity, 0)
    if (porSet === 0 || p.unidades % porSet !== 0) return null
    const k = p.unidades / porSet
    if (n != null && n !== k) return null
    n = k
  }
  return n
}

// El stepper de la caja: lo que se puede mover a mano. Llegar (pasar a en_venezuela o entregado) lo
// hace solo el cierre de una recepción, y volver de ahí solo su reversa. Lo único que va hacia atrás
// a mano es una línea de cliente de entregado a en_venezuela: corregir una entrega no toca stock.
// Las líneas landed (no viajan en la caja) y las servidas desde el depósito siguen su flujo.
export function transicionManualPermitida(
  desde: string,
  hacia: string,
  linea: { isLanded: boolean; desdeStock?: boolean; esCliente: boolean },
): boolean {
  if (linea.isLanded || linea.desdeStock || desde === hacia) return true
  const d = statusIndex(desde), h = statusIndex(hacia), ev = statusIndex('en_venezuela')
  if (d < ev) return h < ev
  if (h > d) return true
  return linea.esCliente && desde === 'entregado' && hacia === 'en_venezuela'
}
