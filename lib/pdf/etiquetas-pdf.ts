import { jsPDF } from 'jspdf'

// Etiquetas de estante para imprimir (docs/plan-inventario/05-ubicaciones-conteo.md): un QR con
// "UBI:A-3" (lo que lee lib/qr-bajaj.ts leerEtiqueta) y el estante en grande para leerlo a la vista.
// A4, 3 × 7 por hoja (70 × 42 mm, el formato común de hojas adhesivas). El QR sale del mismo
// escritor que el QR de emparejar (zxing-wasm) y se dibuja módulo por módulo, así es vectorial.
const COLS = 3
const FILAS = 7
const W = 70
const H = 42
const QR = 30
// Margen blanco alrededor del QR: el estándar pide 4 módulos (con 21 módulos en 30 mm, 5,7 mm).
const MARGEN = 6

export async function buildEtiquetasPdf(ubicaciones: string[]): Promise<jsPDF> {
  const { writeBarcode } = await import('zxing-wasm/writer')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const top = (297 - FILAS * H) / 2
  for (let i = 0; i < ubicaciones.length; i++) {
    const u = ubicaciones[i]
    const k = i % (COLS * FILAS)
    if (i > 0 && k === 0) doc.addPage()
    const x = k % COLS * W
    const y = top + Math.floor(k / COLS) * H
    const r = await writeBarcode(`UBI:${u}`, { format: 'QRCode', ecLevel: 'M' })
    if (r.error) throw new Error(`QR de ${u}: ${r.error}`)
    const s = r.symbol
    const m = QR / s.width
    const oscuro = s.data[0] // la esquina de arriba a la izquierda es siempre del patrón de posición
    doc.setFillColor(0, 0, 0)
    for (let fy = 0; fy < s.height; fy++) {
      for (let fx = 0; fx < s.width; fx++) {
        if (s.data[fy * s.width + fx] === oscuro) doc.rect(x + MARGEN + fx * m, y + (H - QR) / 2 + fy * m, m, m, 'F')
      }
    }
    const texto = x + MARGEN + QR + MARGEN
    const ancho = W - (MARGEN + QR + MARGEN) - 3
    let pt = 36
    doc.setFont('helvetica', 'bold')
    while (pt > 10 && (doc.setFontSize(pt), doc.getTextWidth(u)) > ancho) pt -= 2
    const mm = pt * 0.3528 // alto de la letra en mm
    const linea = y + H / 2 + mm * 0.35 // la base, para que las mayúsculas queden centradas
    doc.text(u, texto, linea)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.text('Estante', texto, linea - mm * 0.72 - 1.5)
  }
  return doc
}
