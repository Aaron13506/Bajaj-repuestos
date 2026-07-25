import { jsPDF } from 'jspdf'
import type { UserOptions } from 'jspdf-autotable'

// Primitivas compartidas por los PDF (presupuesto y orden de proveedor) para que los
// dos documentos no se despinten entre sí: mismos márgenes, misma paleta, mismas
// tablas. Medidas en mm sobre A4.

export const MARGIN = 14
export const GRAY = 130
export const DARK = 30

export const BRAND = 'Bajaj Repuestos'
// El PDF usa las fuentes estándar de jsPDF (WinAnsi), que no tienen "→": va "->".
export const TAGLINE = 'Repuestos Pulsar por encargo · India -> Venezuela'

export const TABLE_STYLES: Pick<UserOptions, 'styles' | 'headStyles'> = {
  styles: { fontSize: 9, cellPadding: 2.5, textColor: DARK, lineColor: 230 },
  headStyles: { fillColor: [245, 245, 245], textColor: 100, fontStyle: 'bold', fontSize: 8 },
}

export function newDoc(): jsPDF {
  return new jsPDF({ unit: 'mm', format: 'a4' })
}

// jspdf-autotable cuelga lastAutoTable del doc sin declararlo en los tipos.
export function tableEndY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
}

// Devuelve la Y donde escribir: si `needed` mm no entran en lo que queda de página,
// abre una nueva y arranca arriba. Siempre usar como `y = ensureSpace(doc, y, alto)`
// antes de dibujar un bloque que no debe cortarse.
export function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  const pageHeight = doc.internal.pageSize.getHeight()
  if (y + needed > pageHeight - MARGIN) {
    doc.addPage()
    return MARGIN + 5
  }
  return y
}

export function drawRule(doc: jsPDF, y: number, color = 210) {
  doc.setDrawColor(color)
  doc.line(MARGIN, y, doc.internal.pageSize.getWidth() - MARGIN, y)
}

// Membrete: título de marca y, opcionalmente, el tagline debajo.
export function drawBrand(doc: jsPDF, y: number, tagline = false) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(DARK)
  doc.text(BRAND, MARGIN, y)
  if (tagline) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(GRAY)
    doc.text(TAGLINE, MARGIN, y + 4.5)
  }
}

// Etiqueta chica en gris sobre un valor destacado (ej: CLIENTE / nombre).
export function drawLabeledValue(doc: jsPDF, y: number, label: string, value: string) {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(GRAY)
  doc.text(label, MARGIN, y)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(DARK)
  doc.text(value, MARGIN, y + 5)
  doc.setFont('helvetica', 'normal')
}