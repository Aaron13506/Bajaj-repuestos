'use client'

import PrintButton from '@/components/PrintButton'
import type { ProveedorPdfData } from '@/lib/pdf/proveedor-pdf'

interface ProveedorPdfButtonProps {
  fileName: string
  data: ProveedorPdfData
}

export default function ProveedorPdfButton({ fileName, data }: ProveedorPdfButtonProps) {
  return (
    <PrintButton
      fileName={fileName}
      onGenerate={async () => {
        const { buildProveedorPdf } = await import('@/lib/pdf/proveedor-pdf')
        return buildProveedorPdf(data)
      }}
    />
  )
}
