import Link from 'next/link'
import type { ReactNode } from 'react'
import Miniatura from '@/components/Miniatura'
import { resumenInventario, type FilaInventario } from '@/lib/inventario'
import { agruparPorEnsamble, margenAPrecioDeHoy, SE_PIERDE } from '@/lib/inventario-vista'
import { MOTO_MODELS, formatModels, modelById, toModelIds, type MotoFamily } from '@/lib/modelo'

export const metadata = { title: 'Inventario' }

// Inventario propio: lo que tengo y lo que viene en cajas confirmadas. Se lee por pieza (qué es,
// dónde va, para qué moto, si se vende con ganancia) o por ensamble (como en Nueva venta). Los
// filtros viven en la URL, así un enlace abre la vista exacta. Las reglas de qué cuenta y cómo
// se valúa están en lib/inventario.ts; cómo se agrupa y el margen, en lib/inventario-vista.ts.

const usd = (n: number) => `${n < -0.005 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

const VER = [
  { value: 'todo', label: 'Todo' },
  { value: 'aqui', label: 'Aquí' },
  { value: 'camino', label: 'En camino' },
] as const
type Ver = (typeof VER)[number]['value']
type Por = 'pieza' | 'ensamble'
const FAMILIAS = [...new Set(MOTO_MODELS.map(m => m.family))]

interface Estado { por: Por; ver: Ver; caja: number | null; moto: MotoFamily | null; pierde: boolean; q: string }

interface Props {
  searchParams: Promise<{ q?: string; ver?: string; caja?: string; moto?: string; por?: string; pierde?: string }>
}

const CHIP = (activo: boolean) =>
  `inline-flex items-center gap-1.5 min-h-8 px-3 rounded-full border text-sm font-medium transition-colors ${
    activo ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
  }`
const LINK = 'text-blue-700 hover:underline'

type Fila = FilaInventario & {
  familias: Set<MotoFamily>
  costoUsd: number | null
  ventaUsd: number | null
  margenUsd: number | null
}

export default async function InventarioPage({ searchParams }: Props) {
  const sp = await searchParams
  const inv = await resumenInventario()

  const ver: Ver = VER.some(v => v.value === sp.ver) ? (sp.ver as Ver) : 'todo'
  const cajaId = Number(sp.caja)
  // El envío solo filtra dentro de "En camino": fuera de ahí no hay caja que elegir.
  const caja = ver === 'camino' ? inv.cajas.find(c => c.envioId === cajaId) ?? null : null
  const e: Estado = {
    por: sp.por === 'ensamble' ? 'ensamble' : 'pieza',
    ver,
    caja: caja?.envioId ?? null,
    moto: FAMILIAS.includes(sp.moto as MotoFamily) ? (sp.moto as MotoFamily) : null,
    pierde: sp.pierde === '1',
    q: sp.q?.trim() ?? '',
  }

  const href = (cambios: Partial<Estado>) => {
    const s = { ...e, ...cambios }
    const p = new URLSearchParams()
    if (s.por !== 'pieza') p.set('por', s.por)
    if (s.ver !== 'todo') p.set('ver', s.ver)
    if (s.ver === 'camino' && s.caja != null) p.set('caja', String(s.caja))
    if (s.moto) p.set('moto', s.moto)
    if (s.pierde) p.set('pierde', '1')
    if (s.q) p.set('q', s.q)
    return p.size ? `/inventario?${p}` : '/inventario'
  }
  const sinFiltros: Partial<Estado> = { ver: 'todo', caja: null, moto: null, pierde: false, q: '' }

  const filas: Fila[] = inv.filas.map(f => ({
    ...f,
    familias: new Set(toModelIds(f.compatibleModels).map(id => modelById(id)!.family)),
    ...margenAPrecioDeHoy(f),
  }))

  const termino = e.q.toLowerCase()
  const enLugar = (f: Fila) =>
    (e.ver === 'aqui' ? f.aqui !== 0 : e.ver === 'camino' ? f.caminoAereo + f.caminoMaritimo > 0 : true) &&
    (e.caja == null || f.cajas.some(c => c.envioId === e.caja))
  const pasa = (f: Fila) =>
    enLugar(f) &&
    (!e.moto || f.familias.has(e.moto)) &&
    (!e.pierde || SE_PIERDE(f.margenUsd)) &&
    (!termino ||
      [f.nameEs, f.bajajCode ?? '', f.compatibleModels ?? '', ...f.ensambles.flatMap(x => [x.nombre, x.subgrupo])]
        .some(s => s.toLowerCase().includes(termino)))

  // Lo que más plata representa arriba.
  const visibles = filas.filter(pasa).sort((a, b) =>
    (b.costoUsd ?? 0) - (a.costoUsd ?? 0) ||
    b.aqui + b.caminoAereo + b.caminoMaritimo - (a.aqui + a.caminoAereo + a.caminoMaritimo) ||
    a.nameEs.localeCompare(b.nameEs))

  // Los conteos de cada filtro, sobre lo que ya filtra el lugar (aquí / en camino / envío).
  const contarVer = (v: Ver) => filas.filter(f => v === 'aqui' ? f.aqui !== 0 : v === 'camino' ? f.caminoAereo + f.caminoMaritimo > 0 : true).length
  const enEsteLugar = filas.filter(enLugar)
  const motos = FAMILIAS
    .map(fam => ({ fam, n: enEsteLugar.filter(f => f.familias.has(fam)).length }))
    .filter(m => m.n > 0 || m.fam === e.moto)
  const cajas = inv.cajas.map(c => {
    const suyas = filas.filter(f => f.cajas.some(x => x.envioId === c.envioId))
    return { ...c, piezas: suyas.length }
  })

  const conCosto = filas.filter(f => f.margenUsd != null)
  const ventaTotal = conCosto.reduce((s, f) => s + f.ventaUsd!, 0)
  const margenTotal = conCosto.reduce((s, f) => s + f.margenUsd!, 0)
  const aPerdida = filas.filter(f => SE_PIERDE(f.margenUsd)).length
  const sinPrecioOCosto = filas.length - conCosto.length

  const hayFiltro = e.ver !== 'todo' || e.moto != null || e.pierde || e.q !== ''
  const titulo = caja ? `Viene en ${caja.modo === 'maritimo_cbm' ? '🚢' : '✈️'} ${caja.nombre}`
    : e.pierde ? 'Cuestan más que su precio'
      : e.por === 'ensamble' ? 'Ensambles' : 'Piezas'
  const deMoto = e.moto ? ` · ${e.moto}` : ''

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Inventario</h1>
        <p className="text-sm text-gray-500 mt-1 text-pretty">
          Lo tuyo: lo que ya llegó y lo que viaja en una caja <span className="font-medium text-gray-700">confirmada</span>.
          Un pedido propio fuera de una caja, o en una caja en borrador, todavía no es una compra.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        <div className="p-4 min-w-0">
          <p className="text-xs text-gray-500">Aquí · a costo de reposición</p>
          <p className="text-2xl font-bold tabular-nums text-gray-900">{usd(inv.aqui.valorUsd)}</p>
          <p className="text-xs text-gray-600 mt-1 tabular-nums">{inv.aqui.unidades} u. de {plural(inv.aqui.productos, 'pieza', 'piezas')}</p>
          {inv.aqui.sinCosto > 0 && (
            <p className="text-xs text-amber-800 mt-0.5">{plural(inv.aqui.sinCosto, 'pieza sin costo cargado', 'piezas sin costo cargado')}: no están en la suma</p>
          )}
        </div>
        <div className="p-4 min-w-0">
          <p className="text-xs text-gray-500">En camino · puesto en Venezuela</p>
          <p className="text-2xl font-bold tabular-nums text-gray-900">{usd(inv.camino.valorUsd)}</p>
          <p className="text-xs text-gray-600 mt-1 tabular-nums">
            {inv.camino.unidades} u. en {plural(inv.cajas.length, 'caja confirmada', 'cajas confirmadas')}
          </p>
          {inv.camino.incompleto && (
            <p className="text-xs text-amber-800 mt-0.5">Estimado: a alguna caja le falta el peso real o una factura</p>
          )}
          {inv.sinResolver > 0 && (
            <p className="text-xs text-amber-800 mt-0.5">
              {plural(inv.sinResolver, 'pieza de conjunto sin identificar', 'piezas de conjuntos sin identificar')} en el catálogo
            </p>
          )}
        </div>
        <div className="p-4 min-w-0">
          <p className="text-xs text-gray-500">Si se vende todo a precio de hoy</p>
          <p className="text-2xl font-bold tabular-nums text-gray-900">{usd(ventaTotal)}</p>
          <p className="text-xs text-gray-600 mt-1 tabular-nums">margen {usd(margenTotal)}</p>
          {aPerdida > 0 && (
            <Link href={href({ ...sinFiltros, pierde: true })} className="inline-flex items-center min-h-6 text-xs font-semibold text-red-700 hover:underline">
              {plural(aPerdida, 'pieza cuesta', 'piezas cuestan')} más que su precio →
            </Link>
          )}
          {sinPrecioOCosto > 0 && (
            <p className="text-xs text-gray-500 mt-0.5">Sin contar {plural(sinPrecioOCosto, 'pieza', 'piezas')} sin precio o sin costo</p>
          )}
        </div>
      </div>

      <section aria-labelledby="lista-h" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 sm:px-5 py-3 space-y-3 border-b border-gray-100">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <nav aria-label="Ver por" className="inline-flex gap-1 p-1 bg-gray-100 rounded-lg">
                {(['pieza', 'ensamble'] as const).map(p => (
                  <Link
                    key={p}
                    href={href({ por: p })}
                    aria-current={e.por === p ? 'true' : undefined}
                    className={`inline-flex items-center min-h-8 px-3 rounded-md text-sm font-medium ${
                      e.por === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {p === 'pieza' ? 'Por pieza' : 'Por ensamble'}
                  </Link>
                ))}
              </nav>
              <div role="group" aria-label="Dónde está" className="flex flex-wrap gap-2">
                {VER.map(v => (
                  <Link key={v.value} href={href({ ver: v.value, caja: null })} aria-current={e.ver === v.value ? 'true' : undefined} className={CHIP(e.ver === v.value)}>
                    {v.label} <span className="text-xs opacity-80 tabular-nums">{contarVer(v.value)}</span>
                  </Link>
                ))}
              </div>
            </div>
            <form action="/inventario" role="search" className="flex items-end gap-2 w-full sm:w-auto">
              {e.por !== 'pieza' && <input type="hidden" name="por" value={e.por} />}
              {e.ver !== 'todo' && <input type="hidden" name="ver" value={e.ver} />}
              {e.caja != null && <input type="hidden" name="caja" value={e.caja} />}
              {e.moto && <input type="hidden" name="moto" value={e.moto} />}
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 min-w-0 flex-1 sm:w-72">
                Buscar
                <input
                  type="search"
                  name="q"
                  defaultValue={e.q}
                  placeholder="Pieza, ensamble, moto o SKU"
                  className="h-10 w-full border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </label>
              <button type="submit" className="h-10 px-4 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50">
                Buscar
              </button>
            </form>
          </div>

          {e.ver === 'camino' && cajas.length > 0 && (
            <div role="group" aria-label="Envío" className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-600 me-1">Envío</span>
              <Link href={href({ caja: null })} aria-current={e.caja == null ? 'true' : undefined} className={CHIP(e.caja == null)}>
                Todos <span className="text-xs opacity-80 tabular-nums">{cajas.length}</span>
              </Link>
              {cajas.map(c => (
                <Link key={c.envioId} href={href({ caja: c.envioId })} aria-current={e.caja === c.envioId ? 'true' : undefined} className={CHIP(e.caja === c.envioId)}>
                  {c.modo === 'maritimo_cbm' ? '🚢' : '✈️'} {c.nombre}
                  <span className="text-xs opacity-80 tabular-nums">{plural(c.piezas, 'pieza', 'piezas')} · {usd(c.valorUsd)}</span>
                </Link>
              ))}
            </div>
          )}

          {motos.length > 1 && (
            <div role="group" aria-label="Moto" className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-600 me-1">Moto</span>
              {motos.map(m => (
                <Link
                  key={m.fam}
                  href={href({ moto: e.moto === m.fam ? null : m.fam })}
                  aria-current={e.moto === m.fam ? 'true' : undefined}
                  className={CHIP(e.moto === m.fam)}
                >
                  {m.fam} <span className="text-xs opacity-80 tabular-nums">{m.n}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-100">
          <h2 id="lista-h" className="text-base font-semibold text-gray-900">{titulo}{deMoto}</h2>
          <p className="text-sm text-gray-600 tabular-nums">
            {plural(visibles.length, 'pieza', 'piezas')}{hayFiltro && ` de ${filas.length}`}
            {caja && ` · ${usd(caja.valorUsd)} puesto en Venezuela`}
          </p>
          {caja && <Link href={`/envios/${caja.envioId}`} className={`inline-flex items-center min-h-8 text-sm ${LINK}`}>Ver la caja →</Link>}
          {hayFiltro && (
            <Link href={href(sinFiltros)} className={`ms-auto inline-flex items-center min-h-8 px-2 text-sm ${LINK}`}>Quitar filtros</Link>
          )}
        </div>

        {filas.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-600">
            <p className="text-base text-gray-900">Todavía no hay mercancía propia ni en camino.</p>
            <p className="mt-1 text-pretty">
              Lo que metas en una caja y confirmes aparece acá como «en camino», y pasa a «aquí» cuando llega.
            </p>
            <p className="mt-3"><Link href="/envios" className={LINK}>Ir a envíos</Link></p>
          </div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-gray-600">
            <p>Nada con esos filtros.</p>
            <p className="mt-2"><Link href={href(sinFiltros)} className={LINK}>Ver todo el inventario</Link></p>
          </div>
        ) : e.por === 'ensamble' ? (
          <PorEnsamble filas={visibles} abiertos={e.q !== ''} termino={termino} moto={e.moto} />
        ) : (
          <PorPieza filas={visibles} />
        )}
      </section>
    </div>
  )
}

// ── Piezas ─────────────────────────────────────────────────────────────────────

function Cantidades({ aqui, camino }: { aqui: number; camino: number }) {
  return (
    <>
      {aqui !== 0 && (
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${aqui > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
          aquí {aqui}
        </span>
      )}
      {camino > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap bg-blue-100 text-blue-800">en camino {camino}</span>}
    </>
  )
}

function Margen({ f, compacto = false }: { f: Fila; compacto?: boolean }) {
  if (f.margenUsd == null) {
    return <span className="text-xs text-gray-500">{f.precioUsd == null ? 'sin precio' : 'sin costo'}</span>
  }
  if (SE_PIERDE(f.margenUsd)) {
    return <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-800 whitespace-nowrap">Perdés {usd(-f.margenUsd)}</span>
  }
  const pct = f.ventaUsd! > 0 ? Math.round((f.margenUsd / f.ventaUsd!) * 100) : 0
  return compacto
    ? <span className="text-sm tabular-nums text-gray-600">+{usd(f.margenUsd)}</span>
    : (
      <span className="inline-flex flex-col items-end">
        <span className="tabular-nums text-gray-900">+{usd(f.margenUsd)}</span>
        <span className="text-xs text-gray-500 tabular-nums">{pct}%</span>
      </span>
    )
}

function DondeVa({ f }: { f: Fila }) {
  const [principal, ...otros] = f.ensambles
  if (!principal) return null
  return (
    <p className="text-xs text-gray-600 break-words">
      Va en {principal.nombre}
      {principal.subgrupo && principal.subgrupo !== principal.nombre && <> › {principal.subgrupo}</>}
      {otros.length > 0 && <span className="text-gray-500"> y {plural(otros.length, 'ensamble más', 'ensambles más')}</span>}
    </p>
  )
}

const motosDe = (f: Fila) => formatModels(toModelIds(f.compatibleModels))

function CajasDe({ f }: { f: Fila }) {
  if (f.cajas.length === 0) return null
  return (
    <span className="flex flex-wrap gap-x-3">
      {f.cajas.map(c => (
        <Link key={c.envioId} href={`/envios/${c.envioId}`} className={`inline-flex items-center min-h-6 text-xs whitespace-nowrap ${LINK}`}>
          {c.modo === 'maritimo_cbm' ? '🚢' : '✈️'} {c.nombre} · {c.unidades} u.
        </Link>
      ))}
    </span>
  )
}

function Costo({ f }: { f: Fila }) {
  return f.costoUsd == null
    ? <span className="text-xs text-amber-800">sin costo</span>
    : <span className="tabular-nums text-gray-700">{usd(f.costoUsd)}</span>
}

function PorPieza({ filas }: { filas: Fila[] }) {
  return (
    <>
      <div className="hidden lg:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100 text-xs text-gray-600">
            <tr>
              <th scope="col" className="text-left font-medium ps-5 pe-4 py-2.5">Pieza</th>
              <th scope="col" className="text-right font-medium px-3 py-2.5">Aquí</th>
              <th scope="col" className="text-right font-medium px-3 py-2.5 whitespace-nowrap">En camino</th>
              <th scope="col" className="text-right font-medium px-3 py-2.5 whitespace-nowrap">Te costó</th>
              <th scope="col" className="text-right font-medium px-3 py-2.5 whitespace-nowrap">A precio de hoy</th>
              <th scope="col" className="text-right font-medium ps-3 pe-5 py-2.5">Margen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filas.map(f => {
              const camino = f.caminoAereo + f.caminoMaritimo
              return (
                <tr key={f.productId} className="align-top hover:bg-gray-50">
                  <td className="ps-5 pe-4 py-3">
                    <div className="flex gap-3 min-w-0">
                      <Miniatura src={f.ensambles[0]?.imageUrl ?? null} />
                      <div className="min-w-0">
                        <Link href={`/products/${f.productId}`} className="font-medium text-gray-900 hover:text-blue-700 hover:underline break-words">
                          {f.nameEs}
                        </Link>
                        <DondeVa f={f} />
                        <p className="text-xs text-gray-600 break-words">
                          {motosDe(f) || 'sin moto cargada'}
                          <span aria-hidden="true" className="text-gray-400"> · </span>
                          <span className="font-mono text-gray-500">{f.bajajCode ?? 'sin SKU'}</span>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={`px-3 py-3 text-right tabular-nums ${f.aqui > 0 ? 'font-semibold text-gray-900' : f.aqui < 0 ? 'font-semibold text-red-700' : 'text-gray-500'}`}>
                    {f.aqui}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className={`tabular-nums ${camino > 0 ? 'font-semibold text-blue-700' : 'text-gray-500'}`}>{camino}</span>
                    <span className="flex justify-end"><CajasDe f={f} /></span>
                  </td>
                  <td className="px-3 py-3 text-right"><Costo f={f} /></td>
                  <td className="px-3 py-3 text-right tabular-nums text-gray-700">
                    {f.ventaUsd == null ? <span className="text-xs text-gray-500">sin precio</span> : (
                      <>
                        {usd(f.ventaUsd)}
                        <span className="block text-xs text-gray-500">{usd(f.precioUsd!)} c/u</span>
                      </>
                    )}
                  </td>
                  <td className="ps-3 pe-5 py-3 text-right"><Margen f={f} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className="lg:hidden divide-y divide-gray-100">
        {filas.map(f => (
          <li key={f.productId} className="px-4 py-3 flex gap-3">
            <Miniatura src={f.ensambles[0]?.imageUrl ?? null} />
            <div className="min-w-0 flex-1">
              <Link href={`/products/${f.productId}`} className="text-sm font-medium text-gray-900 hover:underline break-words">{f.nameEs}</Link>
              <DondeVa f={f} />
              <p className="text-xs text-gray-600 break-words">
                {motosDe(f) || 'sin moto cargada'} · <span className="font-mono text-gray-500">{f.bajajCode ?? 'sin SKU'}</span>
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                <Cantidades aqui={f.aqui} camino={f.caminoAereo + f.caminoMaritimo} />
                <span className="ms-auto text-right"><Costo f={f} /></span>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <CajasDe f={f} />
                <Margen f={f} compacto />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── Ensambles ──────────────────────────────────────────────────────────────────

const deFamilia = (modelos: string[], fam: MotoFamily) => toModelIds(modelos.join(',')).some(id => modelById(id)!.family === fam)

function PorEnsamble({ filas, abiertos, termino, moto }: { filas: Fila[]; abiertos: boolean; termino: string; moto: MotoFamily | null }) {
  // Con una moto elegida, cada pieza se agrupa solo en los despieces de esa moto (si no tiene
  // ninguno cargado para ella, en todos, para no mandarla a "Sin ensamble").
  const deLaMoto = moto
    ? filas.map(f => {
        const suyos = f.ensambles.filter(x => deFamilia(x.modelos, moto))
        return suyos.length > 0 ? { ...f, ensambles: suyos } : f
      })
    : filas
  // Buscando, quedan los ensambles cuyo nombre coincide o que tienen una pieza que coincide por
  // sí misma; si no, buscar "Headlamp Fairing" traería los 33 despieces de cada tornillo.
  const propia = (f: Fila) => [f.nameEs, f.bajajCode ?? '', f.compatibleModels ?? ''].some(s => s.toLowerCase().includes(termino))
  const grupos = agruparPorEnsamble(deLaMoto).filter(g =>
    !termino || (g.nombre ?? '').toLowerCase().includes(termino) ||
    g.piezas.some(p => propia(p.fila) || p.subgrupo.toLowerCase().includes(termino)))
  return (
    <>
      <p className="px-4 sm:px-5 py-2 text-xs text-gray-600 bg-gray-50 border-b border-gray-100 text-pretty">
        {plural(grupos.length, 'ensamble', 'ensambles')}. Una pieza aparece en cada ensamble donde va; arriba los que juntan más piezas tuyas.
        {moto && ` Solo los despieces de la ${moto}.`}
      </p>
      <ul className="divide-y divide-gray-100">
        {grupos.map(g => {
          const piezas = new Set(g.piezas.map(p => p.fila.productId)).size
          const aqui = g.piezas.reduce((s, p) => s + Math.max(p.fila.aqui, 0), 0)
          const camino = g.piezas.reduce((s, p) => s + p.fila.caminoAereo + p.fila.caminoMaritimo, 0)
          const pierden = g.piezas.filter(p => SE_PIERDE(p.fila.margenUsd)).length
          const nombre = g.nombre ?? 'Sin ensamble'
          // Buscando por una pieza, se dice cuál de las de adentro coincidió.
          const coincide = termino && !nombre.toLowerCase().includes(termino)
            ? g.piezas.find(p => [p.fila.nameEs, p.fila.bajajCode ?? ''].some(s => s.toLowerCase().includes(termino)))?.fila
            : null
          const subgrupos = new Map<string, Fila[]>()
          for (const p of g.piezas) subgrupos.set(p.subgrupo, [...(subgrupos.get(p.subgrupo) ?? []), p.fila])
          return (
            <li key={nombre}>
              <details open={abiertos} className="group">
                <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-gray-50 group-open:bg-blue-50/60">
                  <Miniatura src={g.imageUrl} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 break-words">{nombre}</span>
                    <span className="block text-xs text-gray-600 break-words">
                      tenés {plural(piezas, 'pieza', 'piezas')}
                      {g.modelos.length > 0 && <> · {formatModels(toModelIds(g.modelos.join(',')))}</>}
                    </span>
                    {coincide && (
                      <span className="block text-xs text-amber-800 break-words">
                        contiene <span className="font-mono">{coincide.bajajCode}</span> · {coincide.nameEs}
                      </span>
                    )}
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Cantidades aqui={aqui} camino={camino} />
                      {pierden > 0 && <span className="text-xs font-semibold text-red-700">{plural(pierden, 'a pérdida', 'a pérdida')}</span>}
                    </span>
                  </span>
                  <svg aria-hidden="true" className="size-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </summary>
                <div className="border-t border-blue-100 px-4 sm:px-5 py-3 space-y-3">
                  {[...subgrupos.entries()].map(([sub, fs]) => (
                    <div key={sub || '—'}>
                      {sub && sub !== nombre && <h3 className="text-xs font-semibold text-gray-600 mb-1 break-words">{sub}</h3>}
                      <ul className="divide-y divide-gray-100">
                        {fs.map(f => <PiezaEnEnsamble key={f.productId} f={f} ensamble={g.nombre} />)}
                      </ul>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function PiezaEnEnsamble({ f, ensamble }: { f: Fila; ensamble: string | null }) {
  const otros = f.ensambles.filter(x => x.nombre !== ensamble).map(x => x.nombre)
  const tambien: ReactNode = otros.length === 0 ? null
    : otros.length <= 3 ? <> · también en {otros.join(', ')}</>
      : <> · también en {otros.slice(0, 2).join(', ')} y {otros.length - 2} más</>
  return (
    <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1 basis-56">
        <Link href={`/products/${f.productId}`} className="text-sm font-medium text-gray-900 hover:underline break-words">{f.nameEs}</Link>
        <span className="ms-1 text-xs font-mono text-gray-500">{f.bajajCode ?? 'sin SKU'}</span>
        <span className="block text-xs text-gray-500 break-words">{motosDe(f) || 'sin moto cargada'}{tambien}</span>
        <CajasDe f={f} />
      </div>
      <span className="flex flex-wrap gap-1.5"><Cantidades aqui={f.aqui} camino={f.caminoAereo + f.caminoMaritimo} /></span>
      <span className="w-20 text-right text-sm"><Costo f={f} /></span>
      <span className="w-28 text-right"><Margen f={f} compacto /></span>
    </li>
  )
}
