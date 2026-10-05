import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import {
  BRAND,
  DARK,
  GRAY,
  MARGIN,
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
  /** Moto a la que pertenece la línea. Solo se llena si el producto apunta a una sola. */
  modelo?: string | null
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
  /** Presupuesto de cliente a "dólar BCV": los montos ya vienen convertidos. */
  modoBcv: boolean
  tasaBcv: number | null
  /** Escalón de brecha vigente; 0 = no se menciona el descuento. */
  descuentoDivisasPct: number
  isPresupuesto: boolean
  deposit: number
  /** Lo cobrado y el saldo, en la unidad del documento (dólares BCV si modoBcv). */
  depositUsd: number | null
  saldoUsd: number | null
  depositAt: string | null
  paymentMethod: string | null
  terminos: string | null
}

// Escala vertical única (mm). Antes cada bloque sumaba su propio salto a ojo (+4, +7,
// +9, +10, +11…) y por eso el documento respiraba distinto en cada parte.
const SECCION = 8 // entre bloques: encabezado, cliente, tabla, totales, términos
const LINEA_NOTA = 4 // texto chico (8 pt) debajo del total
const FRANJA_ALTO = 9 // cada franja del resumen: descuento, abono, adelanto, saldo
const FRANJA_GAP = 2 // entre franjas
const PAD_X = 2.5 // padding horizontal de las celdas
const SANGRIA_PIEZA = 4 // piezas de un conjunto, debajo de su línea

type Rgb = [number, number, number]
type Celda = { content: string; colSpan?: number; styles?: Record<string, unknown> }

const VERDE = { fondo: [220, 252, 231] as Rgb, texto: [22, 101, 52] as Rgb }
const AMARILLO = { fondo: [254, 249, 195] as Rgb, texto: [133, 100, 4] as Rgb }
const NEUTRO = { fondo: [245, 245, 245] as Rgb, texto: [DARK, DARK, DARK] as Rgb }

// Una franja del resumen: etiqueta a la izquierda, valor a la derecha. Todas miden lo
// mismo y dejan el mismo hueco, así varias seguidas forman una sola columna pareja.
function drawFranja(doc: jsPDF, y: number, label: string, value: string, colores: { fondo: Rgb; texto: Rgb }): number {
  const pageWidth = doc.internal.pageSize.getWidth()
  y = ensureSpace(doc, y, FRANJA_ALTO)
  doc.setFillColor(...colores.fondo)
  doc.rect(MARGIN, y, pageWidth - MARGIN * 2, FRANJA_ALTO, 'F')
  const base = y + FRANJA_ALTO / 2 + 1.2
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(...colores.texto)
  doc.text(label, MARGIN + 3, base)
  doc.text(value, pageWidth - MARGIN - 3, base, { align: 'right' })
  return y + FRANJA_ALTO + FRANJA_GAP
}

// Las filas de una línea del presupuesto: nombre con cantidad y montos, debajo código ·
// moto, y las piezas si es un conjunto. Sin rayas internas: una sola raya cierra el
// bloque. Con el tema a rayas de antes cada pieza salía con su propio fondo y se leía
// como otra línea del presupuesto.
function filasDeItem(item: PresupuestoPdfItem): Celda[][] {
  const filas: { celdas: Celda[]; sangria: number }[] = []
  filas.push({
    sangria: 0,
    celdas: [
      { content: item.nameEs, styles: { fontStyle: 'bold' } },
      { content: String(item.quantity), styles: { halign: 'center' } },
      { content: `$${item.unitPrice.toFixed(2)}`, styles: { halign: 'right' } },
      { content: `$${item.subtotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold' } },
    ],
  })
  const meta = [item.bajajCode, item.modelo].filter(Boolean).join('  ·  ')
  if (meta) {
    filas.push({ sangria: 0, celdas: [{ content: meta, colSpan: 4, styles: { fontSize: 8, textColor: GRAY } }] })
  }
  const grupos = groupBundlePieces(item.bundlePieces)
  // El subgrupo solo dice algo cuando hay más de uno; con uno solo repite el nombre de la línea.
  const conSubgrupos = grupos.length > 1
  for (const [groupName, pieces] of grupos) {
    if (conSubgrupos && groupName !== '—') {
      filas.push({
        sangria: SANGRIA_PIEZA,
        celdas: [{ content: groupName, colSpan: 4, styles: { fontSize: 7.5, fontStyle: 'bold', textColor: GRAY } }],
      })
    }
    for (const p of pieces) {
      // Cantidad POR SET: la columna Cant. de la fila del conjunto ya es el
      // multiplicador; poner el total acá lo aplicaba dos veces al leerlo.
      const code = p.bajajCode ? `  ·  ${p.bajajCode}` : ''
      filas.push({
        sangria: SANGRIA_PIEZA,
        celdas: [{ content: `${p.quantity}×  ${p.nameEs}${code}`, colSpan: 4, styles: { fontSize: 8, textColor: 90 } }],
      })
    }
  }
  // Aire arriba en la primera fila del bloque y abajo en la última; apretado entre medio.
  return filas.map(({ celdas, sangria }, i) => {
    const primera = i === 0
    const ultima = i === filas.length - 1
    return celdas.map(c => ({
      ...c,
      styles: {
        ...c.styles,
        cellPadding: { top: primera ? 3 : 0.8, bottom: ultima ? 3 : 0.4, left: PAD_X + sangria, right: PAD_X },
        lineWidth: { bottom: ultima ? 0.2 : 0 },
      },
    }))
  })
}

export function buildPresupuestoPdf(data: PresupuestoPdfData): jsPDF {
  const doc = newDoc()
  const pageWidth = doc.internal.pageSize.getWidth()
  const anchoUtil = pageWidth - MARGIN * 2
  let y = 18

  // ── Encabezado: la columna derecha comparte líneas base con la marca y el tagline.
  drawBrand(doc, y, true)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(DARK)
  doc.text(`${data.docLabel} ${data.numero}`, pageWidth - MARGIN, y, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(GRAY)
  doc.text(`Fecha: ${data.fecha}`, pageWidth - MARGIN, y + 4.5, { align: 'right' })
  if (data.validez) {
    doc.text(`Válido hasta: ${data.validez}`, pageWidth - MARGIN, y + 9, { align: 'right' })
  }
  y += 14
  drawRule(doc, y)
  y += SECCION

  // ── Cliente y notas
  drawLabeledValue(doc, y, 'CLIENTE', data.clientName)
  y += 5
  if (data.notas) {
    y += 7
    doc.setFontSize(7.5)
    doc.setTextColor(GRAY)
    doc.text('NOTAS', MARGIN, y)
    doc.setFontSize(9)
    doc.setTextColor(70)
    const notasLines = doc.splitTextToSize(data.notas, anchoUtil)
    doc.text(notasLines, MARGIN, y + 4.5)
    y += 4.5 + (notasLines.length - 1) * 4
  }
  y += SECCION

  // ── Tabla. Los encabezados se alinean como su columna: antes iban todos a la izquierda
  // y "Cant." o "Subtotal" quedaban corridos respecto de sus números.
  const head: Celda[] = [
    { content: 'PIEZA' },
    { content: 'CANT.', styles: { halign: 'center' } },
    { content: data.modoBcv ? 'P. UNIT. (BCV)' : 'P. UNIT.', styles: { halign: 'right' } },
    { content: 'SUBTOTAL', styles: { halign: 'right' } },
  ]
  autoTable(doc, {
    startY: y,
    head: [head],
    body: data.items.flatMap(filasDeItem),
    theme: 'plain',
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, textColor: DARK, lineColor: 225, cellPadding: { top: 3, bottom: 3, left: PAD_X, right: PAD_X } },
    headStyles: { fillColor: [245, 245, 245], textColor: 110, fontStyle: 'bold', fontSize: 7.5, lineWidth: { bottom: 0.3 }, lineColor: 200 },
    columnStyles: {
      1: { cellWidth: 16 },
      2: { cellWidth: 30 },
      3: { cellWidth: 28 },
    },
  })

  // ── Total y sus aclaraciones (mismo cuerpo e interlineado, sea BCV o referencia en Bs)
  y = ensureSpace(doc, tableEndY(doc) + SECCION + 2, 24)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(DARK)
  doc.text(data.modoBcv ? 'Total USD (BCV)' : 'Total USD', MARGIN, y)
  doc.setFontSize(15)
  doc.setTextColor(29, 78, 216)
  doc.text(`$${data.total.toFixed(2)}`, pageWidth - MARGIN, y, { align: 'right' })

  const aclaraciones: [string, string | null][] = []
  if (data.modoBcv) {
    aclaraciones.push(['Monto expresado en dólares a tasa BCV.', null])
    aclaraciones.push(['Se paga a la tasa BCV del día en que se realice el pago.', null])
    // Informativo, junto a las otras aclaraciones: en una franja de color al lado de los
    // montos parecía un descuento ya aplicado al total.
    if (data.descuentoDivisasPct > 0) {
      aclaraciones.push([`Pagando en divisas se aplica un descuento del ${data.descuentoDivisasPct}%.`, null])
    }
  }
  if (data.totalBsd != null) {
    aclaraciones.push(['Referencia en bolívares', `Bs ${Math.round(data.totalBsd).toLocaleString('es-VE')}`])
  }
  if (aclaraciones.length > 0) {
    y += 1
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(GRAY)
    for (const [texto, valor] of aclaraciones) {
      y += LINEA_NOTA
      doc.text(texto, MARGIN, y)
      if (valor) doc.text(valor, pageWidth - MARGIN, y, { align: 'right' })
    }
  }
  y += SECCION - 2

  // ── Franjas del resumen, una por dato
  if (data.isPresupuesto) {
    y = drawFranja(doc, y, 'Abono mínimo 50% para confirmar', `$${data.deposit.toFixed(2)}`, AMARILLO)
  } else if (data.depositUsd != null) {
    const label = ['Abonado', data.paymentMethod, data.depositAt].filter(Boolean).join(' · ')
    y = drawFranja(doc, y, label, `$${data.depositUsd.toFixed(2)}`, VERDE)
    y = drawFranja(doc, y, 'Saldo pendiente', `$${(data.saldoUsd ?? 0).toFixed(2)}`, NEUTRO)
  }

  // ── Términos: un párrafo por cláusula, con aire entre ellas
  if (data.terminos) {
    y = ensureSpace(doc, y - FRANJA_GAP + SECCION, 20)
    drawRule(doc, y, 220)
    y += 6
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(GRAY)
    doc.text('TÉRMINOS Y CONDICIONES', MARGIN, y)
    y += 4.5
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(90)
    const parrafos = data.terminos.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    for (const parrafo of parrafos) {
      for (const line of doc.splitTextToSize(parrafo, anchoUtil) as string[]) {
        y = ensureSpace(doc, y, 4)
        doc.text(line, MARGIN, y)
        y += 3.4
      }
      y += 1.2
    }
  }

  const pageCount = doc.getNumberOfPages()
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(GRAY)
  const footerText =
    `${BRAND} · ${data.modoBcv ? 'Precios en dólares a tasa BCV' : 'Precios en dólares (USD)'}` +
    (data.totalBsd != null ? ' · referencia BsD a la tasa del día' : '') +
    ` · ${data.fecha}`
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.text(footerText, pageWidth / 2, pageHeight - 8, { align: 'center' })
  }

  return doc
}
