import { CATEGORIA_LABELS, leerFiltroLibro, listarMovimientos } from '@/lib/movimientos'
import { CUENTA_LABELS } from '@/lib/cuentas'

// El libro filtrado como CSV, para respaldo o para el contador. Separador ";" y coma decimal:
// es lo que abre bien Excel en español con doble clic. El BOM hace que lea los acentos.
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams)
  const { rango, filtro } = leerFiltroLibro(sp)
  // shortcut: tope de 100.000 filas, subirlo o paginar si el libro llega a eso.
  const movimientos = await listarMovimientos(100_000, rango, filtro)

  const celda = (v: string | number | null) => {
    if (v == null) return ''
    const s = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : v
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const filas = [
    ['Fecha', 'Tipo', 'Categoría', 'Cuenta', 'Monto USD', 'Monto Bs', 'Tasa Bs', 'Método', 'Nota', 'Pedido', 'Cliente', 'Envío', 'Proveedor'],
    ...movimientos.map(m => [
      m.fecha.toISOString().slice(0, 10),
      m.tipo,
      CATEGORIA_LABELS[m.categoria as keyof typeof CATEGORIA_LABELS] ?? m.categoria,
      m.cuenta ? CUENTA_LABELS[m.cuenta as keyof typeof CUENTA_LABELS] ?? m.cuenta : null,
      m.tipo === 'ingreso' ? m.monto : -m.monto,
      m.montoBs,
      m.tasaBs != null ? String(m.tasaBs).replace('.', ',') : null, // la tasa con todos sus decimales
      m.metodoPago,
      m.descripcion,
      m.pedido ? `#${m.pedido.id}` : null,
      m.pedido?.clientName ?? null,
      m.envio ? m.envio.nombre ?? `Envío #${m.envio.id}` : null,
      m.supplier?.name ?? null,
    ]),
  ]
  const csv = '﻿' + filas.map(f => f.map(celda).join(';')).join('\r\n')
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="libro-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
