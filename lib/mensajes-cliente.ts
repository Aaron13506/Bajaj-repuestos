import type { ShippingStatus } from './shipping-status'

// Mensaje de WhatsApp para contarle al cliente cómo va su pedido, según la etapa más atrasada
// de lo ya comprado (stageSummary.lead). De usted pero cálido: nombre de pila, un emoji que
// diga algo (nunca la bandera de USA: no se revela la ruta) y solo el signo de cierre (! ?),
// como se escribe en WhatsApp acá — decisión del dueño, en todos por igual. El de "llegó"
// dice lo que falta pagar con los mismos montos que el detalle (dólar BCV, Bs y divisas).
// '#N' se reemplaza por el número del pedido.

interface Texto { saludo: string; texto: string }

const ETAPA: Record<ShippingStatus, Texto> = {
  pendiente: { saludo: '👋', texto: 'Ya estamos gestionando su pedido #N con el proveedor. Apenas esté comprado, le avisamos.' },
  camino_shoppre: { saludo: '👋', texto: 'Buenas noticias: su pedido #N ya está comprado 🎉 y va rumbo a nuestro depósito en India.' },
  en_shoppre: { saludo: '👋', texto: 'Su pedido #N ya está en nuestro depósito en India 📦 y lo estamos preparando para el envío internacional.' },
  // "Despachado" porque un proveedor cotizado arranca directo acá, sin pasar por el depósito.
  camino_usa: { saludo: '👋', texto: 'Su pedido #N ya fue despachado ✈️ y viene en tránsito internacional.' },
  en_usa: { saludo: '👋', texto: 'Su pedido #N ya llegó a nuestro centro de consolidación y se prepara para el último tramo a Venezuela.' },
  camino_venezuela: { saludo: '👋', texto: 'Su pedido #N ya viene en camino a Venezuela 🇻🇪 Falta poco! Le avisamos apenas llegue.' },
  en_venezuela: { saludo: '🎉', texto: 'Su pedido #N ya llegó y está listo para entregar!' },
  entregado: { saludo: '', texto: 'Su pedido #N ya fue entregado ✅ Muchas gracias por confiar en nosotros! Cualquier cosa con las piezas, aquí estamos.' },
}

// "Camino a Venezuela" es una sola etapa, pero el cliente quiere saber en qué va: el dueño
// elige la versión al mandar el mensaje. No se guarda; no mueve etapas. 'puerto' no se dice
// porque la aérea entra por Maiquetía. La demora va sin 👋: es una mala noticia.
export const VERSIONES_VENEZUELA = [
  { value: 'transito', label: 'En tránsito', ...ETAPA.camino_venezuela },
  { value: 'aduana', label: 'En aduana', saludo: '👋', texto: 'Su pedido #N ya está en Venezuela 🇻🇪 y ahora pasa por aduana. Le avisamos en cuanto lo liberen.' },
  { value: 'desconsolidacion', label: 'Desconsolidación', saludo: '👋', texto: 'Su pedido #N ya salió de aduana ✅ y estamos separando la carga para apartar sus piezas.' },
  { value: 'caracas', label: 'Rumbo a Caracas', saludo: '👋', texto: 'Su pedido #N ya viene rumbo a Caracas 🚚 Ya casi! Muy pronto le escribimos para coordinar la entrega.' },
  { value: 'demora', label: 'Demora en aduana', saludo: '', texto: 'Su pedido #N está tardando un poco más de lo normal en aduana ⏳ Lo seguimos de cerca y le avisamos apenas avance. Gracias por la paciencia!' },
] as const

export interface MensajeInput {
  nombre: string
  pedidoId: number
  etapa: ShippingStatus
  // Solo en camino_venezuela; sin ella, la versión "En tránsito".
  version?: (typeof VERSIONES_VENEZUELA)[number]['value']
  // Piezas que todavía no se compraron: la etapa líder no las mira, el mensaje sí tiene que decirlo.
  porComprar: number
  // Lo que falta pagar. bcv/bs solo si el pedido se cobra a dólar BCV.
  porPagar: { usd: number; bcv: boolean; bs: number | null; divisas: number }
}

const usd = (n: number) => `$${n.toFixed(2)}`
const bs = (n: number) => `Bs ${n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Primera palabra del nombre, con mayúscula: "samuel alvarado" → "Samuel".
export function nombreDePila(nombre: string): string {
  const p = nombre.trim().split(/\s+/)[0] ?? ''
  return p.charAt(0).toLocaleUpperCase('es') + p.slice(1)
}

export function mensajeEstado(m: MensajeInput): string {
  const t: Texto = (m.etapa === 'camino_venezuela' && VERSIONES_VENEZUELA.find(v => v.value === m.version)) || ETAPA[m.etapa]
  const pila = nombreDePila(m.nombre)
  const partes = [`Hola${pila ? `, ${pila}` : ''}!${t.saludo ? ` ${t.saludo}` : ''} ${t.texto.replace('#N', `#${m.pedidoId}`)}`]
  if (m.porComprar > 0 && m.etapa !== 'pendiente') {
    partes.push(`${m.porComprar === 1 ? 'Queda 1 pieza' : `Quedan ${m.porComprar} piezas`} por comprar; le avisamos cuando avance.`)
  }
  if (m.etapa === 'en_venezuela') {
    const p = m.porPagar
    if (p.usd <= 0.005) partes.push('Ya está pagado completo, así que solo falta coordinar la entrega 🙌')
    else if (p.bcv) {
      partes.push(
        `Para retirarlo, el monto pendiente es ${usd(p.usd)} a tasa BCV${p.bs != null ? ` (${bs(p.bs)})` : ''}, o ${usd(p.divisas)} si paga en divisas.`,
      )
    } else partes.push(`Para retirarlo, el monto pendiente es ${usd(p.usd)}.`)
    partes.push('Cuándo le queda bien recibirlo?')
  }
  return partes.join('\n\n')
}
