'use client'

import CopiarJson from '@/components/CopiarJson'
import { embarqueAJson } from '@/lib/export-embarque'
import type { LineaEmbarque } from '@/components/EmbarqueMaritimo'

// El "Copiar JSON" de un embarque cerrado. La página es un componente de server y no le
// puede pasar a CopiarJson una función (`obtener`): esa función tiene que nacer acá, del
// lado del cliente, con los datos que sí viajan.
export default function CopiarEmbarqueJson({
  embarque,
  proveedor,
  lineas,
  className,
}: {
  embarque: string
  proveedor: string | null
  lineas: LineaEmbarque[]
  className?: string
}) {
  return (
    <CopiarJson
      obtener={() => embarqueAJson({ embarque, proveedor }, lineas)}
      label={`Copiar JSON (${lineas.length})`}
      title="Copiar el contenido del embarque como JSON"
      className={className}
    />
  )
}
