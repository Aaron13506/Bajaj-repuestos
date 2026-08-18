// ─────────────────────────────────────────────────────────────────────────────
// Encabezados de las columnas de costo del catálogo.
//
// Se muestran SIEMPRE las dos rutas, una al lado de la otra, y por eso este set es fijo:
// hubo un interruptor global que cambiaba las columnas según el "modo activo", y era peor
// que inútil — obligaba a acordarse de moverlo para responder una pregunta que uno se hace
// todo el tiempo (¿esta pieza conviene por aire o por barco?). Teniendo las dos a la vista,
// la comparación ES la respuesta.
//
// El bloque gris (aéreo) es el que manda en el precio de venta: los pedidos de cliente
// salen por ahí. El bloque celeste (marítimo CBM) es la ruta de abastecimiento propio.
//
// Viven en lib y no junto a las celdas (components/ProductRow) porque ese módulo es
// 'use client' y las tablas se arman en el server, que no puede llamar a una función
// exportada desde un módulo cliente. Cualquier cambio acá tiene que espejarse en CostCells.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostColumn { label: string; title?: string; className?: string }

// 'list' = tabla del catálogo (holgada). 'compact' = tabla de componentes dentro de la
// ficha de un ensamble, que va más apretada y hereda el color del <tr>.
export type CostHeaderVariant = 'list' | 'compact'

export function costHeaders(variant: CostHeaderVariant = 'list'): CostColumn[] {
  const TH_BASE = variant === 'compact' ? 'text-right px-2 py-2 font-medium' : 'text-right px-4 py-3 font-medium'
  const gris = variant === 'compact' ? TH_BASE : `${TH_BASE} text-gray-500`
  const mar = `${TH_BASE} text-sky-700 bg-sky-50`
  return [
    { label: 'Costo origen', className: `${gris} border-l border-gray-100` },
    { label: 'Producto',     className: gris },
    // ── Ruta aérea (Shoppre): la que usa el precio de venta ──
    { label: 'Shoppre',      className: gris },
    { label: 'Seguro',       className: gris },
    { label: 'Marítimo',     title: 'Tramo Miami → Caracas del recorrido aéreo', className: gris },
    { label: 'Flete hoy',    className: gris },
    { label: '✈️ Landed',    title: 'Costo puesto en Venezuela por la ruta aérea. Es el que define el precio de venta', className: `${TH_BASE} text-gray-500 font-semibold border-l border-gray-200` },
    // ── Ruta marítima (CBM): la de abastecimiento propio ──
    { label: 'm³',           title: 'Volumen de la pieza — la unidad que factura la naviera', className: `${mar} border-l-2 border-sky-200` },
    { label: '🚢 Flete mar', title: 'Flete India → Venezuela por mar: su parte del m³ más el prorrateo del FOB fijo', className: mar },
    { label: 'Landed mar',   title: 'Costo puesto en Venezuela si se trae por barco', className: `${TH_BASE} font-semibold text-sky-800 bg-sky-50` },
    { label: 'Venta mar',    title: 'Precio de venta que saldría por mar: mismo margen sobre el landed marítimo', className: mar },
    { label: 'Δ',            title: 'Cuánto cambia el costo por mar frente al aéreo — negativo es más barato por barco', className: `${mar} border-r-2 border-sky-200` },
    // ── Resultado comercial ──
    { label: 'Margen',       className: `${gris} border-l border-gray-100` },
    { label: 'Precio USD',   className: gris },
    { label: 'Precio BsD',   className: gris },
  ]
}
