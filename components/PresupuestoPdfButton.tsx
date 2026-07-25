'use client'

import PrintButton from '@/components/PrintButton'
import type { PresupuestoPdfData } from '@/lib/pdf/presupuesto-pdf'

interface PresupuestoPdfButtonProps {
  fileName: string
  data: PresupuestoPdfData
}

export default function PresupuestoPdfButton({ fileName, data }: PresupuestoPdfButtonProps) {
  return (
    <PrintButton
      fileName={fileName}
      onGenerate={async () => {
        const { buildPresupuestoPdf } = await import('@/lib/pdf/presupuesto-pdf')
        return buildPresupuestoPdf(data)
      }}
    />
  )
}
