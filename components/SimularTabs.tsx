'use client'

import { useState, type ReactNode } from 'react'

// Dos herramientas, dos preguntas, una pantalla. Están juntas porque las dos son
// "¿cuánto me sale traer esto?" sobre una caja que todavía no existe, pero no se pueden
// fusionar: una elige PROVEEDOR dentro del carril aéreo (mismo avión, mismo barco de
// Miami a Caracas: lo único que cambia es el tramo India→USA y el precio de la mercancía)
// y la otra elige CARRIL (aire contra mar, que son dos cadenas logísticas enteras con
// unidades de cobro distintas — kilos contra metros cúbicos). Mezclarlas daría una tabla
// donde media fila se cobra por peso y la otra media por volumen.
//
// Las dos arrancan de un presupuesto ya creado, que es de donde salen las preguntas
// reales: "este pedido, ¿se lo compro a Garuda o lo traigo como siempre?" y "este pedido,
// ¿lo mando por aire o lo meto en el próximo embarque?".

const TABS = [
  {
    id: 'compra' as const,
    titulo: 'A quién le compro',
    sub: 'Un presupuesto (o una lista pegada) contra todos los proveedores, por aire',
  },
  {
    id: 'ruta' as const,
    titulo: 'Por dónde lo traigo',
    sub: 'El mismo presupuesto: aéreo contra marítimo',
  },
]

export default function SimularTabs({ compra, ruta }: { compra: ReactNode; ruta: ReactNode }) {
  const [tab, setTab] = useState<'compra' | 'ruta'>('compra')

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`text-left px-4 py-2.5 rounded-lg border-2 transition-colors ${
              tab === t.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <span className={`block text-sm font-semibold ${tab === t.id ? 'text-blue-900' : 'text-gray-700'}`}>
              {t.titulo}
            </span>
            <span className="block text-xs text-gray-500 mt-0.5">{t.sub}</span>
          </button>
        ))}
      </div>
      {tab === 'compra' ? compra : ruta}
    </div>
  )
}
