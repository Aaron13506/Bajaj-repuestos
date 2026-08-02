'use client'

import { useState } from 'react'

// Una pieza pendiente ya consolidada: la cantidad es la suma de todas las líneas del
// envío que piden ese mismo SKU, porque a la hora de comprar da igual de qué cliente
// venga — se pide una sola vez.
export interface PendienteRow {
  sku: string | null
  name: string
  qty: number
  unitInr: number | null
  unitUsd: number | null
  isLanded: boolean
}

// Un grupo = una orden de compra: un proveedor concreto. Lo pendiente se parte por
// proveedor y no por origen, porque lo que se manda a pedir es exactamente esto.
export interface PendienteGrupo {
  key: string
  proveedor: string
  origen: 'india' | 'china'
  rows: PendienteRow[]
}

interface Props {
  envio: string
  grupos: PendienteGrupo[]
  inrUsd: number
}

const bandera = (o: 'india' | 'china') => (o === 'china' ? '🇨🇳' : '🇮🇳')
const inr = (n: number) => `${Math.round(n).toLocaleString('es-VE')} INR`
const usd = (n: number) => `$${n.toFixed(2)}`

const unidades = (g: PendienteGrupo) => g.rows.reduce((s, r) => s + r.qty, 0)
const totalInr = (g: PendienteGrupo) =>
  g.rows.reduce((s, r) => s + (r.unitInr != null ? r.unitInr * r.qty : 0), 0)
const totalUsd = (g: PendienteGrupo) =>
  g.rows.reduce((s, r) => s + (r.unitUsd != null ? r.unitUsd * r.qty : 0), 0)

// Costo de la fila en la moneda que corresponde: el precio del proveedor (USD) le gana
// al del catálogo (INR), igual que en el cálculo del envío.
function costoTexto(r: PendienteRow): string {
  if (r.unitUsd != null) return usd(r.unitUsd * r.qty)
  if (r.unitInr != null) return inr(r.unitInr * r.qty)
  return '—'
}

// Texto plano para pegar en WhatsApp o en el chat del proveedor. El código va primero
// porque es lo que se busca en el catálogo; el nombre es la confirmación.
function comoTexto(envio: string, grupos: PendienteGrupo[], inrUsd: number): string {
  const partes = grupos.map(g => {
    const lineas = g.rows.map(r => {
      const cod = r.sku ?? 's/código'
      return `${r.qty}× ${cod} — ${r.name}${r.isLanded ? ' (puesto en VE)' : ''}`
    })
    const tInr = totalInr(g)
    const tUsd = totalUsd(g)
    const totales = [
      tInr > 0 ? `${inr(tInr)} ≈ ${usd(tInr / inrUsd)}` : null,
      tUsd > 0 ? usd(tUsd) : null,
    ].filter(Boolean).join(' + ')

    return [
      `${bandera(g.origen)} ${g.proveedor} — ${g.rows.length} ítems · ${unidades(g)} u.`,
      ...lineas,
      totales ? `Total: ${totales}` : null,
    ].filter(Boolean).join('\n')
  })

  return [`Falta por comprar — ${envio}`, '', ...partes].join('\n\n')
}

function comoCsv(grupos: PendienteGrupo[]): string {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const filas = [['origen', 'proveedor', 'codigo', 'pieza', 'cantidad', 'unit_inr', 'unit_usd', 'no_viaja']]
  for (const g of grupos) {
    for (const r of g.rows) {
      filas.push([
        g.origen,
        g.proveedor,
        r.sku ?? '',
        r.name,
        String(r.qty),
        r.unitInr != null ? String(r.unitInr) : '',
        r.unitUsd != null ? String(r.unitUsd) : '',
        r.isLanded ? 'si' : '',
      ])
    }
  }
  return filas.map(f => f.map(esc).join(',')).join('\n')
}

// La app corre en red local por HTTP, donde navigator.clipboard no siempre existe:
// sin el respaldo el botón queda muerto justo en el escenario de uso real.
async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = texto
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function descargar(nombre: string, contenido: string, mime: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  a.click()
  URL.revokeObjectURL(url)
}

export default function PendientesCompraButton({ envio, grupos, inrUsd }: Props) {
  const [abierto, setAbierto] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const items = grupos.reduce((s, g) => s + g.rows.length, 0)
  const uds = grupos.reduce((s, g) => s + unidades(g), 0)
  const inrTotal = grupos.reduce((s, g) => s + totalInr(g), 0)
  const usdTotal = grupos.reduce((s, g) => s + totalUsd(g), 0) + inrTotal / inrUsd
  const slug = envio.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'envio'

  if (grupos.length === 0) {
    return (
      <div className="bg-green-50 border border-green-100 rounded-xl px-6 py-3 mb-4 text-sm text-green-700">
        ✓ No falta nada por comprar en este envío — todos los ítems están marcados como comprados.
      </div>
    )
  }

  function avisar(msg: string) {
    setAviso(msg)
    setTimeout(() => setAviso(null), 2500)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
      <div className="px-6 py-3 border-b border-gray-100 bg-amber-50/60 flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
          🛒 Falta por comprar ({items} {items === 1 ? 'ítem' : 'ítems'} · {uds} u. · ≈ {usd(usdTotal)})
        </h2>
        <div className="flex items-center gap-2">
          {aviso && <span className="text-xs text-green-600 font-medium">{aviso}</span>}
          <button
            type="button"
            onClick={async () => {
              const ok = await copiar(comoTexto(envio, grupos, inrUsd))
              avisar(ok ? '✓ Copiado' : 'No se pudo copiar')
            }}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Copiar lista
          </button>
          <button
            type="button"
            onClick={() => descargar(`falta-comprar-${slug}.csv`, comoCsv(grupos), 'text/csv')}
            className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            CSV
          </button>
          <button
            type="button"
            onClick={() => setAbierto(a => !a)}
            className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-800"
          >
            {abierto ? 'Ocultar' : 'Ver'}
          </button>
        </div>
      </div>

      {abierto && (
        <div className="divide-y divide-gray-100">
          {grupos.map(g => {
            const tInr = totalInr(g)
            const tUsd = totalUsd(g)
            return (
              <div key={g.key}>
                <div className="px-6 py-2 bg-gray-50 flex items-center justify-between text-xs">
                  <span className="font-semibold text-gray-600">
                    {bandera(g.origen)} {g.proveedor}
                  </span>
                  <span className="font-mono text-gray-500">
                    {unidades(g)} u.
                    {tInr > 0 && ` · ${inr(tInr)}`}
                    {tUsd > 0 && ` · ${usd(tUsd)}`}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {g.rows.map((r, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="pl-6 pr-3 py-2 font-mono text-xs text-gray-500 w-32">{r.sku ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-900">
                          {r.name}
                          {r.isLanded && (
                            <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                              no viaja
                            </span>
                          )}
                          {r.unitInr == null && r.unitUsd == null && (
                            <span className="ml-2 text-xs text-amber-600">sin precio</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-gray-700 w-16">×{r.qty}</td>
                        <td className="pr-6 pl-3 py-2 text-right font-mono text-gray-600 w-32">{costoTexto(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
