import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import {
  DARK,
  MARGIN,
  TABLE_STYLES,
  drawBrand,
  drawLabeledValue,
  drawRule,
  ensureSpace,
  newDoc,
  tableEndY,
} from './base'

export interface ProveedorPdfData {
  clientName: string
  lines: Array<{ sku: string; name: string; quantity: number }>
  totalQty: number
}

export function buildProveedorPdf(data: ProveedorPdfData): jsPDF {
  const doc = newDoc()
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = 18

  drawBrand(doc, y)
  y += 8
  drawRule(doc, y)
  y += 9

  drawLabeledValue(doc, y, 'ORDEN PARA PROVEEDOR', data.clientName)
  y += 13

  autoTable(doc, {
    startY: y,
    head: [['SKU', 'Part', 'Qty']],
    body: data.lines.map(l => [
      { content: l.sku, styles: { font: 'courier' } },
      l.name,
      { content: String(l.quantity), styles: { halign: 'center' } },
    ]),
    margin: { left: MARGIN, right: MARGIN },
    ...TABLE_STYLES,
    columnStyles: {
      0: { cellWidth: 32 },
      2: { cellWidth: 20 },
    },
  })

  // Si la tabla terminó pegada al pie, el total va a la página siguiente en vez de
  // dibujarse fuera del área visible (órdenes largas lo perdían).
  y = ensureSpace(doc, tableEndY(doc) + 10, 12)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(DARK)
  doc.text('Total qty', MARGIN, y)
  doc.text(String(data.totalQty), pageWidth - MARGIN, y, { align: 'right' })

  return doc
}
