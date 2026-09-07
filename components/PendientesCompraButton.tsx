'use client'

import { useState } from 'react'
import type { CompraPorEnsamble, EnsambleCompra } from '@/lib/compra-99rpm'

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
  // A 99rpm se le compra entrando a la página del ensamble y tildando piezas, no buscando
  // código por código: para ese grupo la lista se muestra por ensamble y no por SKU. `key`
  // es el grupo de `grupos` al que reemplaza la vista. Null ⇒ no hay nada de 99rpm pendiente.
  compra99: { key: string; datos: CompraPorEnsamble } | null
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

// El grupo de 99rpm como se compra: un encabezado por ensamble y, adentro, un bloque por
// cada "Add to cart" (las piezas a tildar y el Qty a poner). Sale en formato checklist
// porque se sigue con el catálogo abierto al lado, tildando de arriba hacia abajo.
function ensambleTexto(e: EnsambleCompra): string {
  const titulo = [e.nombre, e.modelo].filter(Boolean).join(' · ')
  const lineas = [`${titulo}${e.sku ? ` [${e.sku}]` : ''}`]
  for (const b of e.bloques) {
    lineas.push(`  Qty ${b.qty}${b.qty > 1 ? `  → ${b.unidades} u.` : ''}`)
    for (const p of b.piezas) {
      const cod = p.sku ?? 's/código'
      const extra = b.qty > 1 ? ` = ${p.unidades} u.` : ''
      lineas.push(`    [ ] ${p.base}× ${cod} — ${p.name}${p.groupName ? ` (${p.groupName})` : ''}${extra}`)
    }
  }
  for (const a of e.avisos) lineas.push(`  ⚠ ${a}`)
  return lineas.join('\n')
}

function compra99Texto(g: PendienteGrupo, datos: CompraPorEnsamble): string {
  const cab =
    `${bandera(g.origen)} ${g.proveedor} — ${datos.ensambles.length} ensambles · ` +
    `${datos.totalBloques} pasadas · ${datos.totalUnidades} u.`
  const cuerpo = datos.ensambles.map(ensambleTexto)
  const sueltas = datos.sinEnsamble.length > 0
    ? [`Sin ensamble de origen:\n${datos.sinEnsamble.map(s => `  ${s.qty}× ${s.sku ?? 's/código'} — ${s.name}`).join('\n')}`]
    : []
  return [cab, ...cuerpo, ...sueltas].join('\n\n')
}

// Texto plano para pegar en WhatsApp o en el chat del proveedor. El código va primero
// porque es lo que se busca en el catálogo; el nombre es la confirmación.
function comoTexto(
  envio: string,
  grupos: PendienteGrupo[],
  inrUsd: number,
  compra99: { key: string; datos: CompraPorEnsamble } | null,
): string {
  const partes = grupos.map(g => {
    if (compra99 && compra99.key === g.key) return compra99Texto(g, compra99.datos)
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

// La lista de 99rpm en la forma en que se compra: por ensamble, y dentro de cada uno un
// bloque por "Add to cart". Cada pieza cae en un solo bloque, así que lo que ves al lado
// del checkbox es todo lo que lleva esa pieza — no hay que sumar entre bloques.
function Compra99({ datos }: { datos: CompraPorEnsamble }) {
  return (
    <div className="divide-y divide-gray-100">
      {datos.ensambles.map(e => (
        <div key={e.assemblyId} className="px-6 py-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900">
              {e.nombre}
              {e.modelo && <span className="ml-2 font-normal text-gray-500">{e.modelo}</span>}
              {e.sku && <span className="ml-2 font-mono text-xs font-normal text-gray-400">{e.sku}</span>}
            </h3>
            <span className="font-mono text-xs text-gray-400">
              {e.bloques.length} {e.bloques.length === 1 ? 'pasada' : 'pasadas'} · {e.unidades} u.
            </span>
          </div>
          {e.pedidos.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-400">{e.pedidos.join(' · ')}</p>
          )}

          <div className="mt-2 space-y-2">
            {e.bloques.map(b => (
              <div key={b.qty} className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 flex items-center justify-between text-xs">
                  <span className="font-semibold text-gray-700">
                    Qty <span className="font-mono text-sm text-blue-700">{b.qty}</span>
                    <span className="ml-2 font-normal text-gray-400">→ Add to cart</span>
                  </span>
                  <span className="font-mono text-gray-400">
                    {b.piezas.length} {b.piezas.length === 1 ? 'pieza' : 'piezas'} · {b.unidades} u.
                  </span>
                </div>
                <ul className="divide-y divide-gray-50">
                  {b.piezas.map((p, i) => (
                    <li key={i} className="px-3 py-1.5 flex items-center gap-2 text-sm">
                      <span className="text-gray-300 select-none">☐</span>
                      <span className="font-mono text-xs text-gray-700 w-8 text-right shrink-0">{p.base}×</span>
                      <span className="font-mono text-xs text-gray-500 w-28 shrink-0">{p.sku ?? '—'}</span>
                      <span className="flex-1 text-gray-900 truncate" title={p.name}>{p.name}</span>
                      {p.groupName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">
                          {p.groupName}
                        </span>
                      )}
                      {p.descontinuada && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">
                          NLS
                        </span>
                      )}
                      {b.qty > 1 && (
                        <span className="font-mono text-xs text-gray-400 w-14 text-right shrink-0">= {p.unidades} u.</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {e.avisos.map((a, i) => (
            <p key={i} className="mt-1.5 text-xs text-amber-700">⚠ {a}</p>
          ))}
        </div>
      ))}

      {datos.sinEnsamble.length > 0 && (
        <div className="px-6 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Sin ensamble de origen</h3>
          <p className="text-xs text-gray-400">
            Estas líneas no traen desglose, así que no se sabe de qué página de 99rpm salieron.
          </p>
          <ul className="mt-1.5 space-y-1">
            {datos.sinEnsamble.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-gray-700 w-8 text-right">{s.qty}×</span>
                <span className="font-mono text-xs text-gray-500 w-28">{s.sku ?? '—'}</span>
                <span className="text-gray-900">{s.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function PendientesCompraButton({ envio, grupos, inrUsd, compra99 }: Props) {
  const [abierto, setAbierto] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  // La vista plana por SKU sigue a un clic: es la que tiene el costo por fila y sirve
  // para chequear el carrito contra el total, que los bloques no muestran.
  const [porSku, setPorSku] = useState(false)

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
              const ok = await copiar(comoTexto(envio, grupos, inrUsd, porSku ? null : compra99))
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
            const esCompra99 = compra99 != null && compra99.key === g.key
            return (
              <div key={g.key}>
                <div className="px-6 py-2 bg-gray-50 flex items-center justify-between gap-3 text-xs">
                  <span className="font-semibold text-gray-600">
                    {bandera(g.origen)} {g.proveedor}
                    {esCompra99 && !porSku && (
                      <span className="ml-2 font-normal text-gray-400">
                        se compra entrando al ensamble y tildando piezas
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    {esCompra99 && (
                      <button
                        type="button"
                        onClick={() => setPorSku(v => !v)}
                        className="text-blue-600 hover:underline"
                      >
                        {porSku ? 'Ver por ensamble' : 'Ver por SKU'}
                      </button>
                    )}
                    <span className="font-mono text-gray-500">
                      {unidades(g)} u.
                      {tInr > 0 && ` · ${inr(tInr)}`}
                      {tUsd > 0 && ` · ${usd(tUsd)}`}
                    </span>
                  </span>
                </div>
                {esCompra99 && !porSku ? <Compra99 datos={compra99!.datos} /> : (
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
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
