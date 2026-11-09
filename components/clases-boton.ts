// Clases de los botones de presupuestos y pedidos. Viven fuera de los componentes 'use client'
// porque una constante exportada desde uno de esos llega al server como referencia, no como texto.
const base =
  'inline-flex items-center justify-center gap-1.5 min-h-9 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

export const BOTON = {
  primario: `${base} bg-blue-600 text-white hover:bg-blue-700`,
  // Entregar es el paso que cierra el pedido: verde, como el estado "Entregado".
  entregar: `${base} bg-green-600 text-white hover:bg-green-700`,
  secundario: `${base} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`,
  whatsapp: `${base} border border-green-200 bg-white text-green-700 hover:bg-green-50`,
}

// Una opción dentro del menú "Más".
export const ITEM_MENU =
  'flex w-full items-center min-h-9 px-3 py-2 text-left text-sm text-gray-700 rounded-md hover:bg-gray-100 disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed'
export const ITEM_MENU_PELIGRO = `${ITEM_MENU} text-red-700 hover:bg-red-50`
