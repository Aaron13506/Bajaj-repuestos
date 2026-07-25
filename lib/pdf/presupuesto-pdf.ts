import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import {
  BRAND,
  DARK,
  GRAY,
  MARGIN,
  TABLE_STYLES,
  drawBrand,
  drawLabeledValue,
  drawRule,
  ensureSpace,
  newDoc,
  tableEndY,
} from './base'

export interface PresupuestoPdfItem {
  nameEs: string
  bajajCode: string | null
  quantity: number
  unitPrice: number
  subtotal: number
  bundlePieces: BundlePiece[]
}

export interface PresupuestoPdfData {
  docLabel: string
  numero: string
  fecha: string
  validez: string | null
  clientName: string
  notas: string | null
  items: PresupuestoPdfItem[]
  total: number
  totalBsd: number | null
  isPresupuesto: boolean
  deposit: number
  depositUsd: number | null
  saldoUsd: number | null
  depositAt: string | null
  paymentMethod: string | null
  terminos: string | null
}

export function buildPresupuestoPdf(data: PresupuestoPdfData): jsPDF {
  const doc = newDoc()
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = 18

  drawBrand(doc, y, true)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(DARK)
  doc.text(`${data.docLabel} ${data.numero}`, pageWidth - MARGIN, y - 2, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(GRAY)
  doc.text(`Fecha: ${data.fecha}`, pageWidth - MARGIN, y + 2.5, { align: 'right' })
  if (data.validez) {
    doc.text(`Válido hasta: ${data.validez}`, pageWidth - MARGIN, y + 7, { align: 'right' })
  }

  y += 12
  drawRule(doc, y)
  y += 9

  drawLabeledValue(doc, y, 'CLIENTE', data.clientName)
  y += 11

  if (data.notas) {
    doc.setFontSize(7.5)
    doc.setTextColor(GRAY)
    doc.text('NOTAS', MARGIN, y)
    doc.setFontSize(9)
    doc.setTextColor(70)
    const notasLines = doc.splitTextToSize(data.notas, pageWidth - MARGIN * 2)
    doc.text(notasLines, MARGIN, y + 4.5)
    y += 4.5 + notasLines.length * 4 + 4
  }

  const body: (string | { content: string; styles?: Record<string, unknown> })[][] = []
  for (const item of data.items) {
    const title = item.bajajCode ? `${item.nameEs}\n${item.bajajCode}` : item.nameEs
    body.push([
      { content: title },
      { content: String(item.quantity), styles: { halign: 'center' } },
      { content: `$${item.unitPrice.toFixed(2)}`, styles: { halign: 'right' } },
      { content: `$${item.subtotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold' } },
    ])
    for (const [groupName, pieces] of groupBundlePieces(item.bundlePieces)) {
      for (const p of pieces) {
        const label = groupName !== '—' ? `${groupName} · ${p.nameEs}` : p.nameEs
        const code = p.bajajCode ? `  ${p.bajajCode}` : ''
        body.push([
          {
            content: `    ${p.quantity * item.quantity}× ${label}${code}`,
            styles: { fontSize: 8, textColor: GRAY },
          },
          '',
          '',
          '',
        ])
      }
    }
  }

  autoTable(doc, {
    startY: y,
    head: [['Pieza', 'Cant.', 'P. Unit.', 'Subtotal']],
    body,
    margin: { left: MARGIN, right: MARGIN },
    ...TABLE_STYLES,
    columnStyles: {
      1: { cellWidth: 18 },
      2: { cellWidth: 26 },
      3: { cellWidth: 28 },
    },
  })

  y = ensureSpace(doc, tableEndY(doc) + 10, 14)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(DARK)
  doc.text('Total USD', MARGIN, y)
  doc.setFontSize(15)
  doc.setTextColor(29, 78, 216)
  doc.text(`$${data.total.toFixed(2)}`, pageWidth - MARGIN, y, { align: 'right' })
  y += 7

  if (data.totalBsd != null) {
    y = ensureSpace(doc, y, 6)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(GRAY)
    doc.text('Referencia en bolívares', MARGIN, y)
    doc.text(`Bs ${Math.round(data.totalBsd).toLocaleString('es-VE')}`, pageWidth - MARGIN, y, { align: 'right' })
    y += 7
  }

  if (data.isPresupuesto) {
    y = ensureSpace(doc, y, 10)
    doc.setFillColor(254, 249, 195)
    doc.rect(MARGIN, y - 5, pageWidth - MARGIN * 2, 9, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(133, 100, 4)
    doc.text('Abono 50% para confirmar', MARGIN + 3, y)
    doc.text(`$${data.deposit.toFixed(2)}`, pageWidth - MARGIN - 3, y, { align: 'right' })
    y += 10
  } else if (data.depositUsd != null) {
    y = ensureSpace(doc, y, 10)
    doc.setFillColor(220, 252, 231)
    doc.rect(MARGIN, y - 5, pageWidth - MARGIN * 2, 9, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(22, 101, 52)
    const label = data.paymentMethod ? `Adelanto recibido · ${data.paymentMethod}` : 'Adelanto recibido'
    doc.text(label, MARGIN + 3, y)
    doc.text(`$${data.depositUsd.toFixed(2)}`, pageWidth - MARGIN - 3, y, { align: 'right' })
    y += 9

    y = ensureSpace(doc, y, 6)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(DARK)
    doc.text('Saldo pendiente', MARGIN + 3, y)
    doc.text(`$${(data.saldoUsd ?? 0).toFixed(2)}`, pageWidth - MARGIN - 3, y, { align: 'right' })
    y += 5

    if (data.depositAt) {
      y = ensureSpace(doc, y, 5)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(GRAY)
      doc.text(`Adelanto recibido el ${data.depositAt}`, MARGIN + 3, y)
      y += 5
    }
    y += 2
  }

  if (data.terminos) {
    y = ensureSpace(doc, y, 20)
    y += 4
    drawRule(doc, y, 220)
    y += 6
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(GRAY)
    doc.text('TÉRMINOS Y CONDICIONES', MARGIN, y)
    y += 4
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(90)
    const terminosLines = doc.splitTextToSize(data.terminos, pageWidth - MARGIN * 2)
    for (const line of terminosLines) {
      y = ensureSpace(doc, y, 4)
      doc.text(line, MARGIN, y)
      y += 3.6
    }
  }

  const pageCount = doc.getNumberOfPages()
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(GRAY)
  const footerText =
    `${BRAND} · Precios en dólares (USD)` +
    (data.totalBsd != null ? ' · referencia BsD a la tasa del día' : '') +
    ` · ${data.fecha}`
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.text(footerText, pageWidth / 2, pageHeight - 8, { align: 'center' })
  }

  return doc
}
