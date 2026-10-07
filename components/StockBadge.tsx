import type { PosicionesStock } from '@/lib/inventario'

// Lo que ya tengo de una pieza, al lado de ella en los armadores: aquí / en camino (en una
// caja confirmada; un borrador no es una compra y no aparece). Es informativo: no bloquea ni
// cambia cantidades. En un presupuesto de cliente responde "¿esto ya lo tengo o ya viene?";
// armando stock propio, "¿lo estoy comprando dos veces?". Sin nada en ningún lado no se muestra.
export default function StockBadge({
  productId,
  posiciones,
  className = '',
}: {
  productId: number | null | undefined
  posiciones: PosicionesStock | undefined
  className?: string
}) {
  if (productId == null || !posiciones) return null
  const p = posiciones[productId]
  if (!p) return null
  const camino = p.caminoAereo + p.caminoMaritimo
  if (p.aqui === 0 && camino === 0) return null

  const cajas = p.cajas.map(c => `${c.nombre}: ${c.unidades}`).join('\n')
  return (
    <span
      title={cajas || undefined}
      className={`inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap ${className}`}
    >
      {p.aqui !== 0 && (
        <span className={`px-1.5 py-0.5 rounded-full ${p.aqui > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
          aquí {p.aqui}
        </span>
      )}
      {camino > 0 && <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800">en camino {camino}</span>}
    </span>
  )
}
