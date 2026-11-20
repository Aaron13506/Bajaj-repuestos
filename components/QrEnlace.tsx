'use client'

import { useEffect, useState } from 'react'

// Un QR con la URL de una pantalla, para abrirla en el teléfono apuntándole con la cámara (emparejar
// la laptop con el teléfono en una recepción). `base` es APP_URL si está: la laptop puede estar en
// localhost y el teléfono necesita la dirección pública (*.ts.net).
export default function QrEnlace({ ruta, base, texto }: { ruta: string; base?: string | null; texto: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let vivo = true
    // shortcut: el .wasm del escritor se baja de jsDelivr como el del lector; servirlo desde /public si hace falta.
    import('zxing-wasm/writer')
      .then(({ writeBarcode }) => writeBarcode((base || location.origin) + ruta, { format: 'QRCode', scale: 4 }))
      .then(r => { if (vivo && !r.error) setSvg(r.svg) })
      .catch(() => {})
    return () => { vivo = false }
  }, [ruta, base])
  return (
    <figure className="flex items-center gap-3">
      {svg
        ? <div aria-hidden="true" className="size-28 shrink-0 bg-white [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
        : <div aria-hidden="true" className="size-28 shrink-0 rounded bg-gray-100" />}
      <figcaption className="text-sm text-gray-600">
        {texto}
        <a href={ruta} className="mt-1 block font-mono text-xs text-blue-700 underline break-all">{ruta}</a>
      </figcaption>
    </figure>
  )
}
