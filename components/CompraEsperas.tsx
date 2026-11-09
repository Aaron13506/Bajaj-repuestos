'use client'

import Link from 'next/link'
import { useState } from 'react'
import SeccionCaja from '@/components/SeccionCaja'
import { normSku, repartirSinStock, tokensSku } from '@/lib/sin-stock'
import { useAccionDirecta } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

// Las dos tarjetas de la pestaña Comprar que siguen a una pieza después de pagarla: lo que el
// proveedor avisó que no tiene (incidencias "sin_enviar" abiertas) y el buscador por SKU de lo
// comprado que todavía no llegó, desde donde se anota ese aviso (es el único lugar de la caja).

export interface SinStockFila {
  incidenciaId: number
  itemId: number
  pedidoId: number
  clientName: string
  nombre: string
  sku: string | null
  cantidad: number
  /** La pieza del conjunto (null = la línea entera). */
  pieza: string | null
  desde: string
  nota: string | null
  /** No viene nada de la línea: se puede sacar de la caja o pasar a otra (solo en su primera fila). */
  lineaEntera: boolean
  /** Lo que se pagó por estas unidades, si se sabe: la referencia para el reembolso. */
  pagadoUsd: number | null
  propio: boolean
}

/** Un SKU de una línea comprada que todavía no llegó a Venezuela: lo que se puede marcar sin stock. */
export interface PiezaComprada {
  /** `${itemId}::${etiqueta}`: el nombre del campo que va al server (marcarSinStock). */
  key: string
  itemId: number
  /** etiquetaPieza de la pieza del conjunto; '' = la línea es una pieza suelta. */
  etiqueta: string
  sku: string | null
  nombre: string
  /** El conjunto al que pertenece (null = pieza suelta). */
  conjunto: string | null
  pedidoId: number
  clientName: string
  propio: boolean
  /** Unidades todavía sin anotar como "no vino". */
  disponibles: number
}

const btn = 'min-h-8 px-3 py-1 text-xs font-medium border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50'
const btnPri = 'min-h-8 px-3 py-1 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'

interface AccionesSinStock {
  proveedor: string
  /** La caja ya salió del depósito: lo que falta no viene en este embarque. */
  salio: boolean
  resolver: (incidenciaId: number, formData: FormData) => Promise<ActionResult>
  /** null = la caja tiene proveedor: lo pagado está en su cuenta, así que solo se pasa a otra caja. */
  sacar: ((itemId: number) => Promise<ActionResult>) | null
  mover: (itemId: number, formData: FormData) => Promise<ActionResult>
  /** Saca la pieza que no vino del conjunto a una línea propia, que ya puede esperar o cambiar de caja. */
  separar: (incidenciaId: number) => Promise<ActionResult>
  destinos: { id: number; nombre: string }[]
  metodos: readonly string[]
}

export function SinStockCaja({ filas, ...acciones }: AccionesSinStock & { filas: SinStockFila[] }) {
  if (filas.length === 0) return null
  const { proveedor } = acciones
  return (
    <SeccionCaja
      id="sin-stock"
      titulo={`Sin stock en ${proveedor} (${filas.length})`}
      sub={`Pagadas, y ${proveedor} avisó que no tiene. Esperan acá (siguen en el peso y el costo de la caja); antes de despacharla, decidí qué pasa con cada una.`}
      className="!border-amber-300"
    >
      <ul className="divide-y divide-gray-100">
        {filas.map(f => <SinStockItem key={f.incidenciaId} f={f} {...acciones} />)}
      </ul>
    </SeccionCaja>
  )
}

function SinStockItem({ f, proveedor, salio, resolver, sacar, mover, separar, destinos, metodos }: AccionesSinStock & { f: SinStockFila }) {
  const { pending, error, ejecutar } = useAccionDirecta()
  const [reembolso, setReembolso] = useState(false)
  const [destino, setDestino] = useState(destinos[0]?.id ?? 0)
  const campos = (c: Record<string, string>) => {
    const d = new FormData()
    for (const [k, v] of Object.entries(c)) d.set(k, v)
    return d
  }
  const puedeSacar = f.lineaEntera && sacar != null
  const nombre = f.pieza ?? f.nombre
  return (
    <li className="px-4 sm:px-6 py-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm">
          <span className="font-semibold text-gray-900">{nombre}</span>{' '}
          <span className="font-mono text-xs text-gray-500">
            {f.sku && `${f.sku} · `}×{f.cantidad} · #{f.pedidoId} {f.clientName}
          </span>
        </p>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
          {f.lineaEntera ? 'Esperando en esta caja' : 'Esperando'}
        </span>
      </div>
      <p className="text-xs text-gray-600">
        {f.pieza && <>Del conjunto {f.nombre}. </>}
        {proveedor} avisó el {f.desde} que no tiene stock.{' '}
        {!f.lineaEntera
          ? 'Si no llega a tiempo, separala del conjunto: el resto sale con la caja y ella espera sola (para la próxima caja u otra).'
          : salio
            ? <><strong>Esta caja salió sin ella:</strong> decidí si pasa a otra caja, queda para la próxima o se reembolsa.</>
            : 'Se queda en esta caja esperando. La caja no sale del depósito hasta que decidas qué pasa con ella.'}
        {f.nota && <span className="text-gray-500"> · {f.nota}</span>}
      </p>
      {error && <p role="alert" className="text-sm text-red-800 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {!salio && (
          <button type="button" disabled={pending} className={btnPri}
            onClick={() => ejecutar(() => resolver(f.incidenciaId, campos({ resolucion: 'llego' })))}>
            Ya la tienen: llegó al depósito
          </button>
        )}
        {!f.lineaEntera && f.pieza && (
          <button type="button" disabled={pending} className={btn} onClick={() => ejecutar(() => separar(f.incidenciaId))}
            title="El conjunto queda sin esta pieza y ella pasa a una línea propia del mismo pedido. El precio y lo pagado se reparten según lo que vale en el catálogo; el total no cambia.">
            Separarla del conjunto
          </button>
        )}
        {f.lineaEntera && (destinos.length > 0 || puedeSacar) && (
          <span className="text-xs font-semibold text-gray-600 ml-1">Si no llega a tiempo:</span>
        )}
        {puedeSacar && (
          <button type="button" disabled={pending} className={btn} onClick={() => ejecutar(() => sacar(f.itemId))}
            title="Sale de esta caja y queda en «Pagadas esperando caja» (Envíos) hasta que la agregues a la próxima.">
            Dejarla para la próxima caja
          </button>
        )}
        {f.lineaEntera && destinos.length > 0 && (
          <>
            <label className="sr-only" htmlFor={`ss-dest-${f.incidenciaId}`}>Caja a la que pasa {nombre}</label>
            <select id={`ss-dest-${f.incidenciaId}`} value={destino} onChange={e => setDestino(Number(e.target.value))}
              className="min-h-8 max-w-full border border-gray-300 rounded-lg px-2 py-1 text-xs bg-white">
              {destinos.map(d => <option key={d.id} value={d.id}>#{d.id} {d.nombre}</option>)}
            </select>
            <button type="button" disabled={pending} className={btn}
              onClick={() => ejecutar(() => mover(f.itemId, campos({ destinoId: String(destino) })))}>
              Pasarla a esa caja
            </button>
          </>
        )}
        {!reembolso && (
          <button type="button" className={btn} onClick={() => setReembolso(true)}>Dejar de esperar y pedir reembolso</button>
        )}
        <Link href={`/presupuestos/${f.pedidoId}`} className={`${btn} inline-flex items-center`}>
          {f.propio ? `Ver el pedido #${f.pedidoId}` : `Avisar al cliente del pedido #${f.pedidoId}`} →
        </Link>
      </div>
      {reembolso && (
        <form
          className="rounded-lg border border-gray-200 bg-gray-50 p-3 flex flex-wrap items-end gap-3"
          onSubmit={e => {
            e.preventDefault()
            const d = new FormData(e.currentTarget)
            d.set('resolucion', 'reembolso')
            ejecutar(() => resolver(f.incidenciaId, d))
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700">
            Cuánto te devolvió {proveedor} (USD)
            <input name="devueltoProveedorUsd" required inputMode="decimal" autoComplete="off"
              placeholder={f.pagadoUsd != null ? `pagaste ${f.pagadoUsd.toFixed(2)}` : '0.00'}
              className="w-36 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono font-normal bg-white" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700">
            Por dónde
            <select name="metodoDevuelto" defaultValue="" className="min-h-9 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-normal bg-white">
              <option value="">—</option>
              {metodos.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <p className="basis-full text-xs text-gray-600 max-w-prose">
            0 si no te devolvió nada. {f.pieza ? 'La pieza sale del conjunto' : 'Las unidades salen de la caja y del pedido'}; lo pagado que no vuelva queda como pérdida del pedido.
            {!f.propio && ' Lo que le devolvés al cliente se anota en el pedido.'}
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className={btnPri}>Confirmar reembolso</button>
            <button type="button" className={btn} onClick={() => setReembolso(false)}>Cancelar</button>
          </div>
        </form>
      )}
    </li>
  )
}

const grupoDe = (p: PiezaComprada) => (p.sku ? normSku(p.sku) : `n:${p.nombre}`)
const inputNum = 'w-16 border border-gray-300 rounded-lg px-2 py-1 text-sm text-right font-mono bg-white'

// "No tienen stock" por SKU: el proveedor avisa por código, así que se busca por código (también
// dentro de los conjuntos) en vez de recorrer una lista con un botón por línea. Un código que está
// en varios pedidos se reparte con repartirSinStock; cada línea se puede corregir a mano.
export function BuscarSinStock({ piezas, proveedor, marcar }: {
  piezas: PiezaComprada[]
  proveedor: string
  marcar: (formData: FormData) => Promise<ActionResult>
}) {
  const [texto, setTexto] = useState('')
  const [nota, setNota] = useState('')
  const [totales, setTotales] = useState<Record<string, number>>({})
  const [ajustes, setAjustes] = useState<Record<string, number>>({})
  const { pending, error, ejecutar } = useAccionDirecta()
  if (piezas.length === 0) return null

  const porGrupo = new Map<string, PiezaComprada[]>()
  for (const p of piezas) porGrupo.set(grupoDe(p), [...(porGrupo.get(grupoDe(p)) ?? []), p])

  // Cada código pegado busca su SKU exacto; una sola palabra sin código exacto busca por parte del
  // código o del nombre (para cuando no tenés el código entero a mano).
  const tokens = tokensSku(texto)
  const noEstan = tokens.filter(t => !porGrupo.has(t))
  const parcial = tokens.length === 1 && noEstan.length === 1 && texto.trim().length >= 3
  const q = texto.trim().toLowerCase()
  const encontrados: { gk: string; exacto: boolean }[] = parcial
    ? [...porGrupo].filter(([gk, ps]) => gk.includes(tokens[0]) || ps[0].nombre.toLowerCase().includes(q))
      .slice(0, 12).map(([gk]) => ({ gk, exacto: false }))
    : tokens.filter(t => porGrupo.has(t)).map(gk => ({ gk, exacto: true }))

  const grupos = encontrados.map(({ gk, exacto }) => {
    const ls = porGrupo.get(gk)!
    const total = totales[gk] ?? (exacto ? ls.reduce((s, l) => s + l.disponibles, 0) : 0)
    const reparto = repartirSinStock(ls, total)
    return { gk, ls, total, valor: (l: PiezaComprada) => ajustes[l.key] ?? reparto.get(l.key) ?? 0 }
  })
  const aMarcar = grupos.filter(g => g.ls.some(l => g.valor(l) > 0))

  const cambiarTotal = (gk: string, ls: PiezaComprada[], v: number) => {
    setTotales(t => ({ ...t, [gk]: v }))
    setAjustes(a => Object.fromEntries(Object.entries(a).filter(([k]) => !ls.some(l => l.key === k))))
  }
  const enviar = () => {
    const fd = new FormData()
    for (const g of grupos) for (const l of g.ls) if (g.valor(l) > 0) fd.set(`l::${l.key}`, String(g.valor(l)))
    if (nota.trim()) fd.set('nota', nota.trim())
    ejecutar(async () => {
      const r = await marcar(fd)
      if (r.ok) { setTexto(''); setNota(''); setTotales({}); setAjustes({}) }
      return r
    })
  }

  const unidades = piezas.reduce((s, p) => s + p.disponibles, 0)
  return (
    <SeccionCaja
      id="marcar-sin-stock"
      titulo={`¿${proveedor} no tiene algo?`}
      sub={`Escribí o pegá los SKU que te dijo. Busca en lo comprado de esta caja que todavía no llegó a Venezuela, también dentro de los conjuntos.`}
    >
      <div className="px-4 sm:px-6 py-3 space-y-3">
        <label className="block">
          <span className="text-xs font-semibold text-gray-700">SKU sin stock</span>
          <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={texto.includes('\n') ? 3 : 1}
            placeholder="Ej: JF581056, DH151039 (o parte del nombre)" autoComplete="off" spellCheck={false}
            className="mt-1 block w-full max-w-xl border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </label>

        {grupos.length > 0 && (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {grupos.map(g => {
              const disp = g.ls.reduce((s, l) => s + l.disponibles, 0)
              const p0 = g.ls[0]
              return (
                <li key={g.gk} className="px-3 py-2.5 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <p className="min-w-0 text-sm">
                      <span className="font-mono text-xs font-semibold text-gray-700">{p0.sku ?? 'sin código'}</span>{' '}
                      <span className="text-gray-900">{p0.nombre}</span>
                      <span className="block text-xs text-gray-500">
                        compradas {disp} u. · {g.ls.map(l => `#${l.pedidoId} ×${l.disponibles}`).join(' · ')}
                      </span>
                    </p>
                    <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                      No tienen
                      <input type="number" min={0} max={disp} value={g.total} inputMode="numeric"
                        onChange={e => cambiarTotal(g.gk, g.ls, Math.min(disp, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                        className={inputNum} aria-label={`Unidades de ${p0.sku ?? p0.nombre} que no tienen`} />
                      <span className="font-normal text-gray-500">de {disp}</span>
                    </label>
                  </div>
                  {g.ls.length > 1 && g.total > 0 && (
                    <ul className="space-y-1 pl-3 border-l-2 border-gray-100">
                      {g.ls.map(l => (
                        <li key={l.key} className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-gray-600">
                          <span className="min-w-0">
                            #{l.pedidoId} {l.clientName}{l.conjunto && <span className="text-gray-500"> · en {l.conjunto}</span>}
                          </span>
                          <label className="flex items-center gap-1.5">
                            <span className="sr-only">Unidades que esperan en el pedido #{l.pedidoId}</span>
                            <input type="number" min={0} max={l.disponibles} value={g.valor(l)} inputMode="numeric"
                              onChange={e => setAjustes(a => ({ ...a, [l.key]: Math.min(l.disponibles, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))}
                              className={inputNum} />
                            de {l.disponibles}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.ls.length === 1 && p0.conjunto && (
                    <p className="text-xs text-gray-500">en {p0.conjunto} · #{p0.pedidoId} {p0.clientName}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {aMarcar.some(g => g.ls.length > 1) && (
          <p className="text-xs text-gray-500">Si es una parte, espera primero el stock propio y después el pedido más nuevo: el que pagó primero recibe primero.</p>
        )}
        {!parcial && noEstan.length > 0 && (
          <p className="text-xs text-amber-800">
            ✗ {noEstan.join(', ')}: no {noEstan.length === 1 ? 'está' : 'están'} entre lo comprado de esta caja (o ya {noEstan.length === 1 ? 'está anotado' : 'están anotados'}).
          </p>
        )}
        {parcial && grupos.length === 0 && (
          <p className="text-xs text-amber-800">✗ Nada comprado en esta caja coincide con «{texto.trim()}».</p>
        )}
        {error && <p role="alert" className="text-sm text-red-800 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
        {grupos.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-48 max-w-md">
              <span className="text-xs font-semibold text-gray-700">Nota (opcional)</span>
              <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Qué te dijo el proveedor"
                className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
            </label>
            <button type="button" disabled={pending || aMarcar.length === 0} onClick={enviar}
              className="min-h-9 px-4 py-1.5 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {pending ? 'Marcando…' : `Marcar ${aMarcar.length} SKU sin stock`}
            </button>
          </div>
        )}
      </div>

      <details className="group border-t border-gray-100">
        <summary className="px-4 sm:px-6 py-2.5 text-sm text-blue-700 cursor-pointer list-none">
          <span aria-hidden="true" className="inline-block mr-1.5 text-xs transition-transform group-open:rotate-90">▶</span>
          Ver las {porGrupo.size} piezas compradas que todavía no llegaron ({unidades} u.)
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-600">
                <th scope="col" className="text-left px-4 sm:px-6 py-1.5 font-semibold">SKU</th>
                <th scope="col" className="text-left px-3 py-1.5 font-semibold">Pieza</th>
                <th scope="col" className="text-right px-3 py-1.5 font-semibold">Cant.</th>
                <th scope="col" className="text-left px-4 sm:px-6 py-1.5 font-semibold">Pedidos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[...porGrupo].map(([gk, ls]) => (
                <tr key={gk}>
                  <td className="px-4 sm:px-6 py-1.5 font-mono text-xs text-gray-600 whitespace-nowrap">{ls[0].sku ?? '—'}</td>
                  <td className="px-3 py-1.5 text-gray-900">{ls[0].nombre}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-700">{ls.reduce((s, l) => s + l.disponibles, 0)}</td>
                  <td className="px-4 sm:px-6 py-1.5 text-xs text-gray-600">{[...new Set(ls.map(l => `#${l.pedidoId}`))].join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SeccionCaja>
  )
}
