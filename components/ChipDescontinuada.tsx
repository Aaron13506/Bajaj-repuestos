// Marca de pieza descontinuada de fábrica.
//
// Un solo componente para todas las tablas —catálogo, sub-filas de componentes, despiece de
// un ensamble, armador de embarques y de presupuestos— porque cada tabla que lo dibujaba
// por su cuenta era una tabla donde podía faltar, y eso ya pasó: la lista de componentes
// mostraba una pieza que no se fabrica más como si fuera comprable.
//
// Sin 'use client': no tiene estado ni handlers, así que sirve igual en un Server Component
// (la ficha del producto) y dentro de uno cliente (el armador del embarque).

export default function ChipDescontinuada({ activo }: { activo: boolean | null | undefined }) {
  if (!activo) return null
  return (
    <span
      className="ml-2 shrink-0 align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-800"
      title="Descontinuada de fábrica: no la consigue ningún proveedor. Se puede vender el stock que quede, no reponerla"
    >
      descontinuada
    </span>
  )
}
