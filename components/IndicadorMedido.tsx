// Estado del peso y las medidas de una pieza, al lado del peso: "≈ estimado" o "✓ medido".
//
// Solo indica. La marca se pone en la edición de la pieza (completa o rápida), que es donde
// se corrigen los números que se acaban de pesar: marcar desde la tabla dejaba tildar como
// medida una pieza con el número estimado todavía puesto.
//
// Se dibuja en los dos estados: mostrando solo el ✓, un catálogo todo estimado no mostraba
// nada en ningún lado. Sin 'use client', igual que ChipDescontinuada: sirve en un Server
// Component y dentro de uno cliente.

import { textoMedido } from '@/lib/medido'

export default function IndicadorMedido({ medidoAt, className = '' }: {
  medidoAt: Date | string | null | undefined
  className?: string
}) {
  const medido = medidoAt != null
  return (
    <span
      title={medido ? textoMedido(medidoAt) : 'Peso y medidas estimados. Se marca como medida desde Editar.'}
      className={`inline-block whitespace-nowrap font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${
        medido ? 'bg-green-50 text-green-700 border-green-200' : 'text-gray-400 border-gray-200'
      } ${className}`}
    >
      {medido ? '✓ medido' : '≈ estimado'}
    </span>
  )
}
