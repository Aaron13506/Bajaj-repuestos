'use client'

import { useActionState, useEffect, useMemo, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { resolverLista, cargarPedido, type ListaResuelta } from '@/app/(pages)/simular/actions'
import {
  compararCompra,
  claveMontos,
  MONTOS_VACIOS,
  type MontosProveedor,
  type OpcionCompra,
  type PiezaCompra,
  type ProveedorOpcion,
} from '@/lib/comparar-compra'
import { inboundMeta } from '@/lib/inbound'
import { resolveRateTable, CARRIER_DUTY_FREE } from '@/lib/shipping-rates'
import type { ConfigMap } from '@/lib/calc'
import { LISTA_SKU_PROMPT } from '@/lib/prompts'

// ─────────────────────────────────────────────────────────────────────────────
// ¿A quién le compro ESTA canasta, y gano o pierdo contra el camino de siempre?
//
// Nació de una pregunta concreta: Garuda despacha él mismo por India Post y pasa un total
// DDP — ¿esa caja sale más barata que la misma lista por Shoppre? No se puede contestar
// creando el envío, porque crearlo congela la ruta y el proveedor; y no se puede contestar
// a ojo, porque las dos cadenas cobran cosas distintas (una paga tabla escalón + seguro +
// processing, la otra un monto plano y nada encima) sobre precios de mercancía que también
// son distintos.
//
// Tres decisiones sostienen la pantalla:
//
//  · LA CANASTA ENTRA POR DOS PUERTAS Y SALE UNA SOLA. Un presupuesto ya creado o una lista
//    pegada; de ahí para abajo el código no distingue cuál fue. La puerta del presupuesto
//    es la que faltaba: sin ella, para preguntar "¿este presupuesto conviene comprárselo a
//    Garuda?" había que transcribir sus 20 códigos a mano, y una transcripción es una
//    segunda fuente del mismo dato — justo lo que esta pantalla existe para no tener.
//  · LOS PRECIOS POR PIEZA SALEN DE SupplierPrice, nunca de lo pegado. Es lo que se está
//    poniendo a prueba: si el precio viniera en el texto, la comparación mediría cuál se
//    tipeó mejor.
//  · TODO SE RECALCULA EN EL NAVEGADOR, con `calcEnvio`. Las tarifas y los montos del
//    proveedor se mueven mientras se mira el resultado —es el uso normal, no un caso
//    borde— y el número tiene que ser el MISMO que va a mostrar el envío real: la decisión
//    se toma acá pero se paga allá.
//
// El número que la pantalla existe para dar no es el total sino el TOPE: cuánto puede
// cobrar de envío el proveedor que despacha por su cuenta antes de dejar de convenir. Ese
// es el que sirve, porque cuando uno compara todavía no tiene su cotización de flete.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo para poder elegir un presupuesto: sus piezas se resuelven en el servidor. */
export interface PedidoOpcion {
  id: number
  clientName: string
  status: string
  pieceCount: number
  saleTotal: number
}

interface Props {
  /** Proveedores cargados. 99rpm (el precio base en ₹) lo agrega el componente. */
  proveedores: ProveedorOpcion[]
  pedidos: PedidoOpcion[]
  cfg: ConfigMap
}

const listaVacia: ListaResuelta = {
  ok: false, lineas: [], precios: [], noEncontrados: [], sinCodigo: [], errores: [], avisos: [],
}

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`

// Tarifas que se pueden mover para el supuesto. Son las que cambian el resultado del
// carril aéreo; el resto de Config no toca esta comparación y ponerlo acá sería ruido.
const TARIFAS: { key: string; label: string; hint: string; step: string; fallback: string }[] = [
  { key: 'inr_usd_rate', label: 'INR / USD', hint: 'convierte el precio base de 99rpm y el processing', step: '0.01', fallback: '95' },
  { key: 'miami_caracas_per_ft3', label: 'Marítimo USA→VEN ($/ft³)', hint: 'lo pagan todas las opciones por igual', step: '0.5', fallback: '45' },
  { key: 'shoppre_insurance_pct', label: 'Seguro Shoppre (0.03 = 3%)', hint: 'solo sobre lo que pasa por Shoppre', step: '0.005', fallback: '0.03' },
  { key: 'shoppre_processing_inr', label: 'Processing Shoppre (₹)', hint: 'cargo fijo por caja, solo por Shoppre', step: '50', fallback: '500' },
  { key: 'air_volumetric_divisor', label: 'Divisor volumétrico', hint: '5000 estándar; sube el peso cobrable de lo voluminoso', step: '500', fallback: '5000' },
]

type Fuente = 'pedido' | 'lista'

export default function CompararCompra({ proveedores, pedidos, cfg }: Props) {
  const [fuente, setFuente] = useState<Fuente>('pedido')
  const [lista, formAction] = useActionState(resolverLista, listaVacia)
  // La canasta que llegó del servidor, venga de donde venga. Se guarda aparte del
  // useActionState porque el presupuesto no entra por un <form>.
  const [resuelta, setResuelta] = useState<ListaResuelta>(listaVacia)
  const [piezas, setPiezas] = useState<PiezaCompra[]>([])
  const [pedidoId, setPedidoId] = useState<number | null>(null)
  const [cargando, startCarga] = useTransition()

  const [montos, setMontos] = useState<Record<string, MontosProveedor>>({})
  const [tarifas, setTarifas] = useState<Record<string, string>>({})
  const [member, setMember] = useState(cfg.shoppre_member !== 'false')
  // El carrier decide TODO el tramo a USA y hasta ahora no se veía en ninguna parte: la
  // pantalla mostraba un número de flete sin decir de qué servicio salía, así que no había
  // forma de notar si estaba costeando con el barato o con el que se usa de verdad.
  const [carrier, setCarrier] = useState(cfg.shoppre_carrier ?? CARRIER_DUTY_FREE)
  const [aplicarMoq, setAplicarMoq] = useState(true)
  const [referenciaId, setReferenciaId] = useState<number | null>(null)
  const [detalleId, setDetalleId] = useState<number | null | undefined>(undefined)
  const [copiado, setCopiado] = useState(false)
  const [verPrompt, setVerPrompt] = useState(false)

  // Cada carga REEMPLAZA la canasta: es la comparación de UNA compra, y acumular dos
  // listas en silencio daría un total que no corresponde a ninguna.
  function adoptar(r: ListaResuelta) {
    setResuelta(r)
    setPiezas(r.lineas.map(l => ({
      productId: l.productId,
      sku: l.sku,
      nombre: l.nameEs,
      qty: l.qty,
      weightGrams: l.weightGrams,
      dimL: l.dimL, dimA: l.dimA, dimH: l.dimH,
      priceInr: l.priceInr,
    })))
    setDetalleId(undefined)
  }

  // La lista pegada llega por useActionState, así que se adopta cuando cambia.
  useEffect(() => {
    if (lista.lineas.length > 0 || lista.errores.length > 0) adoptar(lista)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lista])

  function elegirPedido(id: number) {
    setPedidoId(id)
    startCarga(async () => adoptar(await cargarPedido(id)))
  }

  function limpiar() {
    setPedidoId(null)
    setResuelta(listaVacia)
    setPiezas([])
    setDetalleId(undefined)
  }

  // 99rpm va primero: es el camino de siempre y la referencia por defecto.
  const opcionesProveedor: ProveedorOpcion[] = useMemo(
    () => [{ id: null, nombre: '99rpm (precio base)', origen: 'india', inbound: 'shoppre' }, ...proveedores],
    [proveedores],
  )

  // Config del supuesto: lo tipeado pisa lo guardado. Un campo vacío vuelve al valor real
  // de Config, así que se puede probar y volver sin recargar.
  const cfgSim: ConfigMap = useMemo(() => {
    const out: ConfigMap = { ...cfg, shoppre_member: member ? 'true' : 'false', shoppre_carrier: carrier }
    for (const [k, v] of Object.entries(tarifas)) {
      if (v.trim() !== '' && Number.isFinite(parseFloat(v))) out[k] = v.trim()
    }
    return out
  }, [cfg, tarifas, member, carrier])

  const { opciones, referencia } = useMemo(
    () => compararCompra(piezas, opcionesProveedor, resuelta.precios, cfgSim, montos, { aplicarMoq, referenciaId }),
    [piezas, opcionesProveedor, resuelta.precios, cfgSim, montos, aplicarMoq, referenciaId],
  )

  const unidades = piezas.reduce((s, p) => s + p.qty, 0)
  const sinMedidas = piezas.filter(p => p.weightGrams == null || !(p.dimL && p.dimA && p.dimH))
  const detalle = detalleId === undefined ? null : opciones.find(o => o.supplierId === detalleId) ?? null
  // El ganador es la más barata que además se pueda comprar de verdad (ver `viable`).
  const ganador = opciones.find(o => o.viable) ?? null
  const tarifasTocadas =
    Object.values(tarifas).some(v => v.trim() !== '') ||
    member !== (cfg.shoppre_member !== 'false') ||
    carrier !== (cfg.shoppre_carrier ?? CARRIER_DUTY_FREE)
  const carriers = useMemo(() => Object.keys(resolveRateTable(cfg).carriers), [cfg])

  function setMonto(id: number | null, campo: keyof MontosProveedor, valor: string) {
    const k = claveMontos(id)
    const n = valor.trim() === '' ? null : parseFloat(valor)
    setMontos(prev => ({
      ...prev,
      [k]: { ...(prev[k] ?? MONTOS_VACIOS), [campo]: Number.isFinite(n as number) ? n : null },
    }))
  }
  const monto = (id: number | null, campo: keyof MontosProveedor) => montos[claveMontos(id)]?.[campo] ?? null

  function setQty(productId: number, qty: number) {
    if (!Number.isFinite(qty) || qty < 1) return
    setPiezas(prev => prev.map(p => (p.productId === productId ? { ...p, qty: Math.round(qty) } : p)))
  }
  function quitar(productId: number) {
    setPiezas(prev => prev.filter(p => p.productId !== productId))
  }

  async function copiarPrompt() {
    try {
      await navigator.clipboard.writeText(LISTA_SKU_PROMPT)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1500)
    } catch {
      setCopiado(false)
    }
  }

  const pedidoElegido = pedidos.find(p => p.id === pedidoId) ?? null

  return (
    <div className="space-y-5">
      {/* ── 1 · La canasta ──────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 pt-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Qué comprás</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Códigos y cantidades. El precio de cada pieza sale de los proveedores cargados — es
              justamente lo que se está comparando.
            </p>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            <FuenteTab activa={fuente === 'pedido'} onClick={() => setFuente('pedido')}>
              📄 Un presupuesto
            </FuenteTab>
            <FuenteTab activa={fuente === 'lista'} onClick={() => setFuente('lista')}>
              📋 Pegar una lista
            </FuenteTab>
          </div>
        </div>

        <div className="px-6 py-4">
          {fuente === 'pedido' ? (
            <div>
              {pedidos.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">No hay presupuestos creados todavía.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={pedidoId ?? ''}
                    onChange={e => (e.target.value === '' ? limpiar() : elegirPedido(parseInt(e.target.value)))}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white min-w-72 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Elegí un presupuesto…</option>
                    {pedidos.map(p => (
                      <option key={p.id} value={p.id}>
                        #{p.id} · {p.clientName} · {p.pieceCount} pzas · {p.status}
                      </option>
                    ))}
                  </select>
                  {cargando && <span className="text-xs text-gray-400">Resolviendo piezas…</span>}
                  {pedidoElegido && !cargando && (
                    <span className="text-xs text-gray-500">
                      Vendido en <span className="font-mono">{usd(pedidoElegido.saleTotal)}</span>. Los conjuntos
                      entran expandidos a sus piezas reales.
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={() => setVerPrompt(v => !v)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {verPrompt ? 'Ocultar prompt' : 'Prompt para sacar el JSON de un PDF'}
                </button>
              </div>

              {verPrompt && (
                <div className="mb-4 bg-gray-50 rounded-lg border border-gray-100 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Copiáselo a la IA junto con el PDF, la foto o la planilla
                    </h3>
                    <button type="button" onClick={copiarPrompt} className="text-xs text-blue-600 hover:underline">
                      {copiado ? '¡Copiado!' : 'Copiar'}
                    </button>
                  </div>
                  <pre className="text-[11px] text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-3 max-h-56 overflow-auto font-mono">
                    {LISTA_SKU_PROMPT}
                  </pre>
                </div>
              )}

              <form action={formAction} className="space-y-3">
                <textarea
                  name="lista"
                  rows={4}
                  placeholder={'[{ "sku": "JR161036", "qty": 2 }, { "sku": "JS121064", "qty": 1 }]\n\nTambién sirve pegar un código por línea:  JR161036 x2'}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <div className="flex items-center gap-3">
                  <SubmitButton />
                  <span className="text-xs text-gray-400">
                    Cruza también por el SKU alterno: si el proveedor usa el otro número del par, la encuentra igual.
                  </span>
                </div>
              </form>
            </div>
          )}

          {/* Los avisos de la canasta viven acá, pegados a lo que los generó. */}
          {resuelta.errores.map((e, i) => (
            <p key={i} className="text-xs text-red-700 bg-red-50 px-3 py-2 rounded-lg mt-3">⚠️ {e}</p>
          ))}
          {resuelta.noEncontrados.length > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mt-3">
              No están en el catálogo: <span className="font-mono">{resuelta.noEncontrados.join(', ')}</span>. No
              entran al supuesto, así que el total les falta.
            </p>
          )}
          {resuelta.sinCodigo.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mt-2">
              {resuelta.sinCodigo.length} renglón{resuelta.sinCodigo.length === 1 ? '' : 'es'} sin código utilizable:
              <ul className="mt-1 list-disc list-inside">
                {resuelta.sinCodigo.map((s, i) => <li key={i}>{s.nombre} ×{s.qty}</li>)}
              </ul>
            </div>
          )}
          {resuelta.avisos.map((a, i) => (
            <p key={i} className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg mt-2">{a}</p>
          ))}

          {piezas.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {piezas.length} {piezas.length === 1 ? 'pieza' : 'piezas'} · {unidades} unidades
                </h3>
                <div className="flex items-center gap-3">
                  {sinMedidas.length > 0 && (
                    <span className="text-[11px] text-amber-700">
                      {sinMedidas.length} sin peso o sin medidas: el flete de esas cuenta 0
                    </span>
                  )}
                  <button type="button" onClick={limpiar} className="text-[11px] text-gray-400 hover:text-red-600">
                    Vaciar
                  </button>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                {piezas.map(p => (
                  <div key={p.productId} className="flex items-center gap-2 px-3 py-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 truncate">{p.nombre}</p>
                      <p className="text-[11px] text-gray-400 font-mono">
                        {p.sku}
                        {(p.weightGrams == null || !(p.dimL && p.dimA && p.dimH)) && (
                          <span className="ml-2 text-amber-600 font-sans">sin medidas</span>
                        )}
                      </p>
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={p.qty}
                      onChange={e => setQty(p.productId, parseInt(e.target.value))}
                      className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm text-center shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => quitar(p.productId)}
                      className="text-gray-300 hover:text-red-500 shrink-0 px-1"
                      title="Quitar"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {piezas.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400">
          <p className="text-lg">Sin canasta todavía</p>
          <p className="text-sm mt-1">
            Elegí un presupuesto o pegá los códigos arriba, y acá aparece qué cuesta traerlos por cada proveedor.
          </p>
        </div>
      ) : (
        <>
          {/* ── 2 · El veredicto ─────────────────────────────────────────── */}
          <Veredicto ganador={ganador} referencia={referencia} onReferencia={setReferenciaId} proveedores={proveedores} />

          {/* ── 3 · Las opciones ─────────────────────────────────────────── */}
          <div className="space-y-3">
            {opciones.map(o => (
              <TarjetaOpcion
                key={o.supplierId ?? 'base'}
                o={o}
                esGanador={ganador?.supplierId === o.supplierId && !o.esReferencia}
                referencia={referencia}
                carrier={carrier}
                tramo={monto(o.supplierId, 'tramoUsd')}
                saliente={monto(o.supplierId, 'comisionSalienteUsd')}
                entrante={monto(o.supplierId, 'comisionEntranteUsd')}
                onMonto={(campo, v) => setMonto(o.supplierId, campo, v)}
                aplicarMoq={aplicarMoq}
                abierto={detalleId !== undefined && detalleId === o.supplierId}
                onDetalle={() =>
                  setDetalleId(prev => (prev !== undefined && prev === o.supplierId ? undefined : o.supplierId))
                }
              />
            ))}
          </div>

          {detalle && <DetallePorPieza o={detalle} referencia={referencia} />}

          {/* ── 4 · El supuesto ──────────────────────────────────────────── */}
          <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <summary className="px-6 py-4 cursor-pointer font-semibold text-gray-900">
              Tarifas del supuesto
              <span className={`ml-2 text-xs font-normal ${tarifasTocadas ? 'text-amber-600' : 'text-gray-400'}`}>
                {tarifasTocadas ? 'modificadas — no se guardan' : 'las de Configuración'}
              </span>
            </summary>
            <div className="px-6 pb-6">
              <p className="text-xs text-gray-400 mb-4">
                Solo para este supuesto: nada de esto se guarda. Vacío = el valor real de Configuración.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {TARIFAS.map(t => (
                  <div key={t.key}>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t.label}</label>
                    <input
                      type="number"
                      step={t.step}
                      value={tarifas[t.key] ?? ''}
                      onChange={e => setTarifas(prev => ({ ...prev, [t.key]: e.target.value }))}
                      placeholder={cfg[t.key] ?? t.fallback}
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">{t.hint}</p>
                  </div>
                ))}
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Servicio de Shoppre</label>
                  <select
                    value={carrier}
                    onChange={e => setCarrier(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {carriers.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">
                    Es la tabla escalón que paga todo lo que entra por Shoppre. El “Economy” es más
                    barato pero no es el que se usa: el vigente en Configuración es{' '}
                    <span className="font-mono">{cfg.shoppre_carrier ?? CARRIER_DUTY_FREE}</span>.
                  </p>
                </div>
                <div className="flex flex-col justify-center gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={member} onChange={e => setMember(e.target.checked)} className="accent-blue-600" />
                    Membresía Shoppre (−5%)
                  </label>
                  <label
                    className="flex items-center gap-2 text-sm text-gray-700"
                    title="El mínimo del proveedor sube la cantidad, y con ella el volumen y el flete de toda la caja"
                  >
                    <input type="checkbox" checked={aplicarMoq} onChange={e => setAplicarMoq(e.target.checked)} className="accent-blue-600" />
                    Aplicar el mínimo de compra (MOQ)
                  </label>
                </div>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

function FuenteTab({ activa, onClick, children }: { activa: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 transition-colors ${
        activa ? 'bg-blue-600 text-white font-medium' : 'bg-white text-gray-600 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
    >
      {pending ? 'Buscando…' : 'Cargar lista'}
    </button>
  )
}

// El titular de la pantalla. Antes había que leer una tabla ordenada para deducirlo; la
// pregunta que se vino a hacer ("¿conviene o no?") merece estar contestada arriba y en
// una línea, con el número de la diferencia y no con el orden de las filas.
function Veredicto({
  ganador, referencia, proveedores, onReferencia,
}: {
  ganador: OpcionCompra | null
  referencia: OpcionCompra | null
  proveedores: ProveedorOpcion[]
  onReferencia: (id: number | null) => void
}) {
  const gana = ganador != null && referencia != null && !ganador.esReferencia && ganador.ahorroUsd > 0
  const empata = ganador != null && referencia != null && Math.abs(ganador.ahorroUsd) < 0.005

  return (
    <section
      className={`rounded-xl border p-5 ${
        gana ? 'bg-green-50 border-green-200' : 'bg-white border-gray-100 shadow-sm'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {referencia == null ? (
            <p className="text-sm text-amber-700">
              El proveedor de referencia no está en la canasta, así que no hay contra qué medir.
            </p>
          ) : ganador == null ? (
            <p className="text-sm text-gray-500">Ningún proveedor cotiza estas piezas.</p>
          ) : gana ? (
            <>
              <p className="text-lg font-semibold text-green-900">
                Conviene <span className="font-bold">{ganador.nombre}</span>: ahorrás{' '}
                <span className="font-mono">{usd(ganador.ahorroUsd)}</span> contra {referencia.nombre}.
              </p>
              <p className="text-sm text-green-800 mt-0.5">
                {usd(ganador.landedUsd)} contra {usd(referencia.landedUsd)} puestos en Venezuela —{' '}
                {((ganador.ahorroUsd / referencia.landedUsd) * 100).toFixed(0)}% menos.
              </p>
            </>
          ) : empata ? (
            <p className="text-lg font-semibold text-gray-900">
              Empatan: {ganador.nombre} sale igual que {referencia.nombre}.
            </p>
          ) : (
            <>
              <p className="text-lg font-semibold text-gray-900">
                Conviene seguir con <span className="font-bold">{referencia.nombre}</span>.
              </p>
              <p className="text-sm text-gray-600 mt-0.5">
                La mejor alternativa ({ganador.nombre}) sale {usd(Math.abs(ganador.ahorroUsd))} más cara.
              </p>
            </>
          )}
        </div>

        <label className="text-xs text-gray-500 flex items-center gap-2 shrink-0">
          Comparar contra
          <select
            value={referencia?.supplierId ?? ''}
            onChange={e => onReferencia(e.target.value === '' ? null : parseInt(e.target.value))}
            className="border border-gray-300 rounded-lg px-2 py-1 text-xs bg-white"
          >
            <option value="">99rpm (precio base)</option>
            {proveedores.map(p => <option key={p.id!} value={p.id!}>{p.nombre}</option>)}
          </select>
        </label>
      </div>
    </section>
  )
}

// Una opción de compra, entera en una tarjeta.
//
// Era una fila de una tabla de nueve columnas con los campos tipeables adentro de las
// celdas, y no entraba: ahora son TRES montos por proveedor (el tramo DDP y las dos puntas
// del giro) y cada aviso —cobertura, MOQ, piezas sin precio, el tope— se apilaba al pie de
// la pantalla lejos del proveedor del que hablaba. En tarjeta, cada opción se lee sola: lo
// que cuesta, de qué está hecho, qué hay que tipear y qué le falta.
function TarjetaOpcion({
  o, esGanador, referencia, carrier, tramo, saliente, entrante, onMonto, aplicarMoq, abierto, onDetalle,
}: {
  o: OpcionCompra
  esGanador: boolean
  referencia: OpcionCompra | null
  /** El servicio de Shoppre con el que se costeó: sin nombrarlo, el flete es un número suelto. */
  carrier: string
  tramo: number | null
  saliente: number | null
  entrante: number | null
  onMonto: (campo: keyof MontosProveedor, v: string) => void
  aplicarMoq: boolean
  abierto: boolean
  onDetalle: () => void
}) {
  const meta = inboundMeta(o.inbound)
  const cotizado = o.inbound === 'cotizado'
  const shoppreUsd = o.b.insuranceUsd + o.b.processingUsd
  const comisionUsd = o.b.comisionUsd

  // Composición del landed. Es la respuesta a "¿por qué esta sale más cara?", que el total
  // solo no contesta: dos opciones con el mismo landed pueden tener la mercancía y el flete
  // invertidos, y eso cambia cuál conviene si mañana se mueve una tarifa.
  const partes = [
    { label: 'Mercancía', v: o.b.productCostUsd, cls: 'bg-slate-400' },
    { label: '→ USA', v: o.b.airUsd, cls: cotizado ? 'bg-emerald-500' : 'bg-blue-500' },
    { label: 'Shoppre', v: shoppreUsd, cls: 'bg-indigo-400' },
    { label: 'Marítimo', v: o.b.maritimeUsd, cls: 'bg-cyan-500' },
    { label: 'Comisiones', v: comisionUsd, cls: 'bg-amber-400' },
  ].filter(p => p.v > 0)
  const total = partes.reduce((s, p) => s + p.v, 0)

  return (
    <section
      className={`bg-white rounded-xl shadow-sm border overflow-hidden ${
        !o.viable ? 'border-gray-100 opacity-60' : esGanador ? 'border-green-300' : 'border-gray-100'
      }`}
    >
      <div className="px-5 py-4">
        {/* Encabezado: quién es, y cuánto sale */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900">{o.nombre}</h3>
              <span
                title={meta.hint}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  cotizado ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {meta.icon} {meta.label}
              </span>
              {o.esReferencia && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">
                  referencia
                </span>
              )}
              {esGanador && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-600 text-white">
                  MÁS BARATA
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {o.supplierId == null
                ? 'Todas las piezas al precio base del catálogo'
                : `Cotiza ${o.cotizadas} de ${o.totalPiezas} piezas`}
              {o.b.chargeableKg > 0 && ` · ${kg(o.b.chargeableKg)} cobrables`}
            </p>
          </div>

          <div className="text-right shrink-0">
            <p className="text-2xl font-bold font-mono text-gray-900">{usd(o.landedUsd)}</p>
            {o.esReferencia ? (
              <p className="text-xs text-gray-400">landed · el camino de siempre</p>
            ) : referencia ? (
              <p className={`text-xs font-mono ${o.ahorroUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {o.ahorroUsd >= 0 ? '−' : '+'}{usd(Math.abs(o.ahorroUsd))} vs {referencia.nombre}
              </p>
            ) : (
              <p className="text-xs text-gray-400">landed</p>
            )}
          </div>
        </div>

        {/* Composición */}
        {total > 0 && (
          <div className="mt-3">
            <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
              {partes.map(p => (
                <div key={p.label} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} title={`${p.label}: ${usd(p.v)}`} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-500">
              {partes.map(p => (
                <span key={p.label} className="flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-sm ${p.cls}`} />
                  {p.label} <span className="font-mono text-gray-700">{usd(p.v)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Lo que hay que tipear: solo lo que esta opción realmente tiene */}
        {o.supplierId != null && (
          <div className="mt-4 flex flex-wrap items-end gap-3 pt-3 border-t border-gray-50">
            {cotizado ? (
              <CampoMonto
                label="Envío a USA (DDP), USD"
                hint="el total que factura por llevar la caja, impuestos incluidos"
                value={tramo}
                onChange={v => onMonto('tramoUsd', v)}
              />
            ) : (
              <div className="text-xs text-gray-400 pb-1.5 max-w-md">
                El tramo a USA lo pone la tabla escalón de{' '}
                <span className="text-gray-600">{carrier}</span>:{' '}
                <span className="font-mono text-gray-600">{usd(o.b.air.costUsd)}</span> por{' '}
                {kg(o.b.air.chargeableKg)}. No hay nada que tipear.
              </div>
            )}
            <CampoMonto
              label="Comisión saliente, USD"
              hint={`lo que te cobra tu banco por girar ${usd(o.b.giro?.montoUsd ?? 0)}`}
              value={saliente}
              onChange={v => onMonto('comisionSalienteUsd', v)}
            />
            <CampoMonto
              label="Comisión entrante, USD"
              hint="lo que le descuentan al recibir y le completás"
              value={entrante}
              onChange={v => onMonto('comisionEntranteUsd', v)}
            />
          </div>
        )}

        {/* Avisos, pegados al proveedor del que hablan */}
        <div className="mt-3 space-y-1.5">
          {o.tramoTopeUsd != null && (
            <p className="text-xs text-gray-700 bg-blue-50 px-3 py-2 rounded-lg">
              💡 Despacha por su cuenta: te puede cobrar hasta{' '}
              <span className="font-mono font-semibold">{usd(o.tramoTopeUsd)}</span> de envío y seguís empatando
              contra {referencia?.nombre}.{' '}
              {tramo == null
                ? 'Todavía no cargaste el suyo, así que hoy figura viajando gratis.'
                : o.ahorroUsd >= 0
                  ? `Cobra ${usd(tramo)}: te sobran ${usd(o.tramoTopeUsd - tramo)}.`
                  : `Cobra ${usd(tramo)}: se pasa por ${usd(tramo - o.tramoTopeUsd)}.`}
            </p>
          )}
          {o.b.air.cajas > 1 && (
            <p className="text-xs text-amber-800 bg-amber-50 px-3 py-2 rounded-lg">
              ⚠️ No entra en una caja: {kg(o.b.air.chargeableKg)} contra un tope de{' '}
              {kg(o.b.air.capKg ?? 0)} por caja. Va en <span className="font-semibold">{o.b.air.cajas} cajas</span>{' '}
              de {kg(o.b.air.cajasKg[0] ?? 0)}, y el flete es la suma de las {o.b.air.cajas} — no el escalón
              más alto de la tabla.
            </p>
          )}
          {!o.viable && (
            <p className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
              No cotiza ninguna de estas piezas: su total sale entero de los precios de 99rpm, así que no
              corresponde a ninguna compra que se pueda hacer.
            </p>
          )}
          {o.sinPrecio.length > 0 && (
            <p className="text-xs text-red-700 bg-red-50 px-3 py-2 rounded-lg">
              {o.sinPrecio.length} pieza{o.sinPrecio.length === 1 ? '' : 's'} sin ningún precio cargado
              ({o.sinPrecio.slice(0, 6).join(', ')}{o.sinPrecio.length > 6 ? '…' : ''}) — entran como $0: el total
              está mal, no solo corto.
            </p>
          )}
          {o.viable && o.noCotizadas.length > 0 && (
            <p className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
              No cotiza {o.noCotizadas.length} de {o.totalPiezas} ({o.noCotizadas.slice(0, 6).join(', ')}
              {o.noCotizadas.length > 6 ? '…' : ''}): esas entran al precio base de 99rpm, así que su total sale
              más barato de lo que sería comprándole solo a él.
            </p>
          )}
          {aplicarMoq && o.viable && o.moq.length > 0 && (
            <p className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
              Su mínimo de compra obliga a llevar {o.unidadesExtra} unidades de más
              ({o.moq.slice(0, 4).map(m => `${m.sku}: ${m.pedida}→${m.minima}`).join(' · ')}
              {o.moq.length > 4 ? '…' : ''}). Están contadas en su total.
            </p>
          )}
          {o.landedDirecto.length > 0 && (
            <p className="text-xs text-sky-800 bg-sky-50 px-3 py-2 rounded-lg">
              Entrega {o.landedDirecto.length} pieza{o.landedDirecto.length === 1 ? '' : 's'} puesta
              {o.landedDirecto.length === 1 ? '' : 's'} en Venezuela: no viajan en la caja ni pagan flete, pero sí
              van en el mismo giro.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onDetalle}
          className="mt-3 text-xs text-blue-600 hover:underline"
        >
          {abierto ? 'Ocultar el landed por pieza' : 'Ver el landed por pieza'}
        </button>
      </div>
    </section>
  )
}

// Un monto que no se puede derivar y hay que tipear. Vacío NO es cero, y el placeholder lo
// dice: un 0 tipeado es un dato ("esa punta no cobró nada") y el vacío es una ausencia.
function CampoMonto({
  label, hint, value, onChange,
}: {
  label: string
  hint: string
  value: number | null
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1" title={hint}>{label}</label>
      <input
        type="number"
        step="0.01"
        min="0"
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="sin cargar"
        title={hint}
        className="w-36 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      <p className="text-[11px] text-gray-400 mt-1 max-w-36">{hint}</p>
    </div>
  )
}

// El landed POR PIEZA es el número con el que se decide de dónde traer cada SKU, y no es
// el total repartido en partes iguales: una pieza pesada carga el tramo aéreo y una
// voluminosa el marítimo. Por eso el ganador del total puede perder en la mitad de las
// piezas — y eso es accionable: esas se le compran al otro.
function DetallePorPieza({ o, referencia }: { o: OpcionCompra; referencia: OpcionCompra | null }) {
  const refPorProducto = new Map((referencia?.b.lines ?? []).map(l => [l.productId, l]))
  const comparable = referencia != null && !o.esReferencia

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-3 flex items-center justify-between border-b border-gray-100">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {o.nombre} · landed por pieza
        </h3>
        {comparable && (
          <span className="text-[11px] text-gray-400">Δ contra {referencia!.nombre}, por unidad</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-6 py-2 font-semibold">Pieza</th>
              <th className="text-right px-3 py-2 font-semibold">Cant.</th>
              <th className="text-right px-3 py-2 font-semibold">Producto</th>
              <th className="text-right px-3 py-2 font-semibold">→ USA</th>
              <th className="text-right px-3 py-2 font-semibold">Marít.</th>
              <th className="text-right px-4 py-2 font-semibold">Landed / u</th>
              {comparable && <th className="text-right px-6 py-2 font-semibold">Δ / u</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {o.b.lines.map(l => {
              const unit = l.quantity > 0 ? l.landedUsd / l.quantity : 0
              const ref = refPorProducto.get(l.productId)
              const unitRef = ref && ref.quantity > 0 ? ref.landedUsd / ref.quantity : null
              const delta = unitRef != null ? unitRef - unit : null
              return (
                <tr key={l.productId} className="hover:bg-gray-50">
                  <td className="px-6 py-2 text-gray-800">
                    {l.name}
                    {l.isLanded && <span className="ml-2 text-[10px] text-sky-700">puesta en VEN</span>}
                    {(l.missingWeight || l.missingDims) && (
                      <span className="ml-2 text-[10px] text-amber-600">sin medidas</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-500">{l.quantity}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600">{usd(l.productCostUsd / l.quantity)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600">{usd(l.airUsd / l.quantity)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600">{usd(l.maritimeUsd / l.quantity)}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">{usd(unit)}</td>
                  {comparable && (
                    <td className="px-6 py-2 text-right font-mono">
                      {delta == null ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <span className={delta >= 0 ? 'text-green-700' : 'text-red-700'}>
                          {delta >= 0 ? '−' : '+'}{usd(Math.abs(delta))}
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
