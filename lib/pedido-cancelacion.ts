// Cancelar un pedido de cliente ya confirmado (puro, sin DB).
//
// No había estado para esto: un cliente que se arrepentía con la seña pagada dejaba un pedido
// vivo para siempre en "por cobrar", y lo único que se podía hacer era nada (no se borra lo que
// tiene plata cobrada). Cancelar hace tres cosas, y cada una tiene su regla:
//
//  · LA PLATA. Lo cobrado es del negocio salvo lo que se devuelve. Los términos dicen que el
//    adelanto no se reembolsa una vez pedida la pieza al proveedor, así que lo que se propone
//    es: nada comprado → devolver todo; algo comprado → no devolver (se queda). La decisión
//    es del dueño y se escribe; lo que no se devuelve es plata que se quedó, y se cuenta en el
//    resultado del mes.
//  · LO COMPRADO. Una pieza que ya se pagó existe: pasa a stock propio con su costo, caja y
//    etapa (ver lib/pedido-edicion → repartirSobrante), no desaparece ni se pierde. Lo que
//    nunca se compró no cuesta nada: sale de su caja y queda en el pedido cancelado como
//    memoria de lo que se había pedido.
//  · LO ENTREGADO. Si ya se le entregó algo al cliente el pedido no se cancela entero: lo que
//    sigue es un reclamo o un reembolso por pieza.
import { estadoLinea } from '@/lib/pedido-edicion'

export interface PedidoCancelable {
  tipo: string
  status: string
  items: { shippingStatus: string; costRealUsd: number | null }[]
}

export function motivoNoCancelable(p: PedidoCancelable): string | null {
  if (p.tipo !== 'cliente') return 'Solo se cancela un pedido de cliente.'
  if (p.status === 'cancelado') return 'Este pedido ya está cancelado.'
  if (p.status === 'presupuesto') return 'Un presupuesto sin confirmar no se cancela: se borra.'
  if (p.items.some(i => estadoLinea(i) === 'entregada')) {
    return 'Ya se le entregó algo al cliente: no se cancela entero. Para lo que falló usá un reclamo o un reembolso por pieza.'
  }
  return null
}

export interface ResumenCancelacion {
  /** Líneas ya compradas: pasan a stock propio. */
  compradas: number
  /** Líneas que nunca se compraron: salen de su caja y se quedan en el pedido cancelado. */
  libres: number
}

export function resumenCancelacion(items: { shippingStatus: string; costRealUsd: number | null }[]): ResumenCancelacion {
  const compradas = items.filter(i => estadoLinea(i) === 'comprada').length
  return { compradas, libres: items.length - compradas }
}

// Cuánto proponer devolver. Con algo comprado la regla de los términos es no devolver; sin nada
// comprado, devolver todo. Es una propuesta: el formulario deja escribir otro monto.
export function devolucionSugerida(depositoUsd: number, resumen: ResumenCancelacion): number {
  return resumen.compradas > 0 ? 0 : depositoUsd
}

// Un monto a devolver válido: entre 0 y lo que el cliente tiene pagado (no se devuelve más de lo
// que entró).
export function motivoDevolucionInvalida(monto: number, depositoUsd: number): string | null {
  if (!Number.isFinite(monto) || monto < 0) return 'El monto a devolver no es válido.'
  if (monto > depositoUsd + 0.005) {
    return `No se puede devolver $${monto.toFixed(2)}: el cliente tiene pagado $${depositoUsd.toFixed(2)}.`
  }
  return null
}
