import type { ShippingStatus } from './shipping-status'

// Mensaje de WhatsApp para contarle al cliente cómo va su pedido, según la etapa más atrasada
// de lo ya comprado (stageSummary.lead). Español neutro, de usted. El de "llegó" dice lo que
// falta pagar con los mismos montos que el detalle (dólar BCV, Bs y divisas).

const ETAPA: Record<ShippingStatus, string> = {
  pendiente: 'ya lo estamos gestionando con el proveedor. Le avisaremos en cuanto esté comprado.',
  camino_shoppre: 'ya fue comprado y va en camino a nuestro depósito en India.',
  en_shoppre: 'ya llegó a nuestro depósito en India y se está preparando para salir hacia Estados Unidos.',
  camino_usa: 'ya va en camino a Estados Unidos.',
  en_usa: 'ya llegó a Estados Unidos y se está preparando para salir hacia Venezuela.',
  camino_venezuela: 'ya va en camino a Venezuela. Le avisaremos apenas llegue.',
  en_venezuela: '¡ya llegó y está listo para entregar!',
  entregado: 'ya fue entregado. Muchas gracias por su compra; cualquier cosa con las piezas, quedamos a la orden.',
}

export interface MensajeInput {
  nombre: string
  pedidoId: number
  etapa: ShippingStatus
  // Piezas que todavía no se compraron: la etapa líder no las mira, el mensaje sí tiene que decirlo.
  porComprar: number
  // Lo que falta pagar. bcv/bs solo si el pedido se cobra a dólar BCV.
  porPagar: { usd: number; bcv: boolean; bs: number | null; divisas: number }
}

const usd = (n: number) => `$${n.toFixed(2)}`
const bs = (n: number) => `Bs ${n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function mensajeEstado(m: MensajeInput): string {
  const partes = [`Hola, ${m.nombre}. Le escribimos sobre su pedido #${m.pedidoId}: ${ETAPA[m.etapa]}`]
  if (m.porComprar > 0 && m.etapa !== 'pendiente') {
    partes.push(`${m.porComprar === 1 ? 'Queda 1 pieza' : `Quedan ${m.porComprar} piezas`} por comprar; le avisaremos cuando avance.`)
  }
  if (m.etapa === 'en_venezuela') {
    const p = m.porPagar
    if (p.usd <= 0.005) partes.push('Su pedido ya está pagado en su totalidad.')
    else if (p.bcv) {
      partes.push(
        `Para retirarlo, el monto a pagar es ${usd(p.usd)} a tasa BCV${p.bs != null ? ` (${bs(p.bs)})` : ''}, o ${usd(p.divisas)} si paga en divisas.`,
      )
    } else partes.push(`Para retirarlo, el monto a pagar es ${usd(p.usd)}.`)
    partes.push('¿Cuándo le queda bien recibirlo?')
  }
  return partes.join('\n\n')
}
