import type { ModoEnvio } from './calc'

// ─────────────────────────────────────────────────────────────────────────────
// RUTA DE UN EMBARQUE
//
// La ruta no es una preferencia de la app: es un hecho de CADA caja, y se elige al
// crearla. Hubo un interruptor global que re-costeaba todo el sistema, y era el modelo
// equivocado — obligaba a acordarse de moverlo, y hacía que una pantalla que solo tiene
// sentido por mar tuviera que avisar "ojo, el modo activo es aéreo". Dos verdades para el
// mismo dato. Ahora la única verdad es `Envio.modo`.
//
//   aereo        India → USA por avión (Shoppre/ShipGlobal) → Venezuela por mar.
//                Cobra PESO: tabla escalón sobre max(real, volumétrico).
//                Es el carril COMERCIAL: pedidos de cliente, que necesitan llegar rápido.
//   maritimo_cbm India → Venezuela por mar, directo. Cobra VOLUMEN: tarifa plana por m³
//                más el FOB, que es fijo por embarque.
//                Es el carril de STOCK: mercancía propia, que puede esperar a consolidar.
//
// Los dos carriles casi no se tocan, y por eso cada uno tiene su propio contenido: el
// aéreo agrupa PedidoItem (líneas comerciales), el marítimo EnvioLinea (mercancía propia).
// ─────────────────────────────────────────────────────────────────────────────

export type ModoApp = 'aereo' | 'maritimo_cbm'

export const MODOS: { value: ModoApp; label: string; short: string; icon: string; hint: string }[] = [
  {
    value: 'aereo',
    label: 'Aéreo',
    short: 'Aéreo',
    icon: '✈️',
    hint: 'India → USA en avión → Venezuela por mar. Se cobra por peso. Es la ruta de los pedidos de cliente.',
  },
  {
    value: 'maritimo_cbm',
    label: 'Marítimo CBM',
    short: 'CBM',
    icon: '🚢',
    hint: 'India → Venezuela directo por mar. Tarifa plana por m³ + FOB fijo. Se cobra por volumen. Es la ruta de la mercancía propia.',
  },
]

export function isModoApp(v: string | null | undefined): v is ModoApp {
  return v === 'aereo' || v === 'maritimo_cbm'
}

export function modoMeta(modo: ModoApp) {
  return MODOS.find(m => m.value === modo)!
}

// Toda ruta de embarque es un modo de cálculo válido; este alias existe para que los
// llamadores no tengan que castear entre los dos tipos.
export function modoToEnvio(modo: ModoApp): ModoEnvio {
  return modo
}

// Ruta con la que se costeó un envío. Cada Envio la congela al crearse. Las filas
// anteriores a esta feature no tienen valor y caen a 'aereo', que es como se costearon.
export function modoDeEnvio(stored: string | null | undefined): ModoApp {
  return isModoApp(stored) ? stored : 'aereo'
}

// ── Estado del embarque ──────────────────────────────────────────────────────
// Solo el marítimo se arma pieza por pieza, así que solo él pasa por 'borrador'. El aéreo
// nace confirmado: sus líneas ya existen (son pedidos que alguien encargó).
export type EstadoEnvio = 'borrador' | 'confirmado'

export function esBorrador(estado: string | null | undefined): boolean {
  return estado === 'borrador'
}
