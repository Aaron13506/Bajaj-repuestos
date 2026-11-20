// Estado del peso y las medidas de una pieza, al lado del peso: "≈ estimado", "✓ caja"
// (o "✓ suelta", lo de bolsa) y "? base" (medida a mano antes de que se guardara la base: re-medir en el
// próximo conteo; /products?medido=sin_base las lista).
//
// Solo indica. La marca se pone en la edición de la pieza (completa o rápida), en el conteo o en
// el modo Medir del teléfono: marcar desde la tabla dejaba tildar como medida una pieza con el
// número estimado todavía puesto.
//
// Se dibuja en todos los estados: mostrando solo el ✓, un catálogo todo estimado no mostraba
// nada en ningún lado. Sin 'use client', igual que ChipDescontinuada: sirve en un Server
// Component y dentro de uno cliente.

import { textoMedido } from '@/lib/medido'

export default function IndicadorMedido({ medidoAt, base, className = '' }: {
  medidoAt: Date | string | null | undefined
  base: string | null | undefined
  className?: string
}) {
  const medido = medidoAt != null
  const [texto, titulo, tono] = !medido
    ? ['≈ estimado', 'Peso y medidas estimados. Se marca como medida desde Editar o al contar.', 'text-gray-500 border-gray-200']
    : base == null
      ? ['? base', `${textoMedido(medidoAt)}, sin saber si con su caja o suelta: re-medila en el próximo conteo.`, 'bg-amber-50 text-amber-800 border-amber-200']
      : [base === 'empaque' ? '✓ caja' : '✓ suelta', `${textoMedido(medidoAt)} (${base === 'empaque' ? 'en su caja' : 'una pieza suelta, viene en bolsa'})`, 'bg-green-50 text-green-700 border-green-200']
  return (
    <span title={titulo} className={`inline-block whitespace-nowrap font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${tono} ${className}`}>
      {texto}
    </span>
  )
}
