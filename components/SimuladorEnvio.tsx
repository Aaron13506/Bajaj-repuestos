'use client'

import { useMemo, useState } from 'react'
import { calcEnvio, type EnvioItemInput, type ConfigMap, type ModoEnvio } from '@/lib/calc'

export interface SimProduct {
  id: number
  nameEs: string
  bajajCode: string | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  price: number
}

export interface SimCostPiece {
  name: string
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  priceInr: number | null
  quantity: number
}

export interface SimPedido {
  id: number
  clientName: string
  status: string
  /** Envíos donde ya hay ítems de este presupuesto (puede estar repartido en varios). */
  envioIds: number[]
  saleTotal: number
  pieceCount: number
  /** Piezas físicas ya resueltas (los conjuntos vienen expandidos a sus piezas reales). */
  costPieces: SimCostPiece[]
}

interface ManualLine {
  product: SimProduct
  quantity: number
}

interface Props {
  products: SimProduct[]
  pedidos: SimPedido[]
  cfg: ConfigMap
  // Escenario en el que abre el simulador: el modo activo de la app.
  modoInicial?: ModoEnvio
}

const usd = (n: number) => `$${n.toFixed(2)}`
const kg = (n: number) => `${n.toFixed(2)} kg`
const ft3 = (n: number) => `${n.toFixed(2)} ft³`
// 3 decimales: una caja chica ronda los 0.0xx m³ y con 2 se vería todo igual.
const m3 = (n: number) => `${n.toFixed(3)} m³`

// Dónde estás parado en la curva de la tarifa.
//
// El $/kg NO tiene un mínimo en el medio: baja siempre, y lo más barato por kilo está en el
// tope de la caja. Lo que pasa a los 11 kg es que deja de bajar RÁPIDO — de ahí para arriba
// la mejora es chica. Los textos hablaban de un "punto dulce" en 11 kg como si fuera el
// óptimo, y encima cotizaban en INR/kg, de cuando la tarifa se guardaba en rupias: hoy la
// tabla es en USD y el tramo aéreo no pasa por `inr_usd_rate`, así que esos números no
// correspondían a nada que se pudiera verificar en la misma pantalla.
//
// Por eso el $/kg que se muestra es el REAL de esta caja (`costPerKgUsd` del breakdown) y no
// una constante escrita a mano: una tarifa hardcodeada envejece con el próximo scrape y
// nadie se entera.
function airTierHint(
  chargeableKg: number,
  costPerKgUsd = 0,
  cajas = 1,
  capKg: number | null = null,
): { tone: 'good' | 'info' | 'warn'; text: string } | null {
  if (chargeableKg <= 0) return null
  const perKg = `$${costPerKgUsd.toFixed(2)}/kg`

  // Pasado el tope por caja el consejo se da vuelta: sumar kilos ya no abarata nada, porque
  // el kilo 23 no entra en un escalón más alto — arranca una caja nueva desde la parte cara
  // de la curva. Decir "estás en el tramo más eficiente" acá empuja para el lado que cuesta.
  if (cajas > 1 && capKg != null) {
    return {
      tone: 'warn',
      text: `Pasaste el tope de ${capKg} kg por caja: van ${cajas} cajas y el flete es la suma de las ` +
            `${cajas}, ${perKg} en promedio. Partir encarece siempre —los primeros kilos de cada caja ` +
            `son los más caros—, así que conviene una sola caja llena antes que dos a medio llenar.`,
    }
  }
  if (capKg != null && chargeableKg > capKg - 1 && chargeableKg <= capKg) {
    return {
      tone: 'good',
      text: `Caja llena: ${chargeableKg.toFixed(1)} de ${capKg} kg, a ${perKg} — lo más barato por kilo que da la tabla. Un kilo más y son dos cajas.`,
    }
  }
  if (chargeableKg < 11) {
    return {
      tone: 'info',
      text: `Vas a ${perKg}, en la parte cara de la curva. Te faltan ${(11 - chargeableKg).toFixed(1)} kg para los 11, ` +
            `donde el flete por kilo cae fuerte; de ahí para arriba sigue bajando pero ya poco.`,
    }
  }
  if (chargeableKg < 20) {
    return {
      tone: 'info',
      text: `Vas a ${perKg}, ya en la parte plana de la curva: sumar kilos sigue abaratando, pero de a poco. ` +
            `Lo más barato por kilo está en el tope de la caja${capKg != null ? ` (${capKg} kg)` : ''}.`,
    }
  }
  return {
    tone: 'good',
    text: capKg != null
      ? `${perKg}: lo más barato por kilo que da la tabla. Te quedan ${(capKg - chargeableKg).toFixed(1)} kg antes del tope de la caja.`
      : `${perKg}: lo más barato por kilo que da la tabla.`,
  }
}

export default function SimuladorEnvio({ products, pedidos, cfg, modoInicial = 'aereo' }: Props) {
  const [selectedPedidoIds, setSelectedPedidoIds] = useState<number[]>([])
  const [manual, setManual] = useState<ManualLine[]>([])
  const [search, setSearch] = useState('')
  // Arranca en el modo con el que se está operando, pero acá sí se puede saltar entre los
  // tres escenarios sin cambiar nada global: el simulador es justamente para comparar.
  const [modo, setModo] = useState<ModoEnvio>(modoInicial)
  // El escenario viejo en ft³ no es una ruta que exista: es una cotización anterior que se
  // conserva para poder mirarla. Estaba como tercer botón al mismo nivel que las dos rutas
  // reales, y eso hacía leer como una decisión ("¿cuál de las tres?") algo que tiene una
  // sola respuesta correcta. Queda a un click, rotulado como lo que es.
  const [verLegacy, setVerLegacy] = useState(modoInicial === 'maritimo')

  const selectedPedidos = useMemo(
    () => selectedPedidoIds.map(id => pedidos.find(p => p.id === id)!).filter(Boolean),
    [selectedPedidoIds, pedidos]
  )

  const availablePedidos = pedidos.filter(p => !selectedPedidoIds.includes(p.id))

  function addPedido(id: number) {
    setSelectedPedidoIds(prev => (prev.includes(id) ? prev : [...prev, id]))
  }
  function removePedido(id: number) {
    setSelectedPedidoIds(prev => prev.filter(x => x !== id))
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return []
    const q = search.toLowerCase()
    return products
      .filter(
        p =>
          (p.nameEs.toLowerCase().includes(q) || p.bajajCode?.toLowerCase().includes(q)) &&
          !manual.find(c => c.product.id === p.id)
      )
      .slice(0, 8)
  }, [search, products, manual])

  function addProduct(p: SimProduct) {
    if (manual.find(c => c.product.id === p.id)) return
    setManual(prev => [...prev, { product: p, quantity: 1 }])
    setSearch('')
  }
  function updateQty(id: number, qty: number) {
    if (qty < 1 || isNaN(qty)) return
    setManual(prev => prev.map(c => (c.product.id === id ? { ...c, quantity: qty } : c)))
  }
  function removeManual(id: number) {
    setManual(prev => prev.filter(c => c.product.id !== id))
  }

  // Aplanar presupuestos + piezas sueltas en items para el mismo cálculo que un envío real.
  // Los conjuntos ya vienen expandidos a sus piezas reales desde el servidor.
  const items: EnvioItemInput[] = [
    ...selectedPedidos.flatMap(ped =>
      ped.costPieces.map(piece => ({
        pedidoId: ped.id,
        productId: 0,
        name: piece.name,
        weightGrams: piece.weightGrams,
        dimL: piece.dimL,
        dimA: piece.dimA,
        dimH: piece.dimH,
        priceInr: piece.priceInr,
        quantity: piece.quantity,
      }))
    ),
    ...manual.map(c => ({
      pedidoId: 0,
      productId: c.product.id,
      name: c.product.nameEs,
      weightGrams: c.product.weightGrams,
      dimL: c.product.dimL,
      dimA: c.product.dimA,
      dimH: c.product.dimH,
      priceInr: c.product.priceInr,
      quantity: c.quantity,
    })),
  ]

  // Se costean SIEMPRE los dos escenarios, no solo el activo: la pregunta del simulador no
  // es "cuánto sale por mar" sino "¿me conviene el mar sobre el aéreo, para esta caja?".
  //
  // Las deps son `itemsKey` y no `items` a propósito, y por eso el linter avisa acá: `items`
  // se arma inline y es un array nuevo en cada render, así que ponerlo en las deps haría
  // que el memo no acierte nunca. La clave serializada determina el contenido por completo.
  const itemsKey = JSON.stringify(items)
  const calcAereo    = useMemo(() => calcEnvio(items, cfg, { modo: 'aereo' }),    [itemsKey, cfg])
  const calcMaritimo = useMemo(() => calcEnvio(items, cfg, { modo: 'maritimo' }), [itemsKey, cfg])
  const calcCbm      = useMemo(() => calcEnvio(items, cfg, { modo: 'maritimo_cbm' }), [itemsKey, cfg])

  const esCbm = modo === 'maritimo_cbm'
  // `esMaritimo` cubre los dos escenarios por mar: en ambos se cobra volumen y el peso deja
  // de importar. Lo específico de CBM (tarifa por m³, FOB fijo, mínimo LCL) va con `esCbm`.
  const esMaritimo = modo === 'maritimo' || esCbm
  const calc = esCbm ? calcCbm : esMaritimo ? calcMaritimo : calcAereo

  // El marítimo directo todavía no tiene tarifa cargada: calcEnvio cae a la de Miami→CCS,
  // que subcotiza mucho el tramo completo desde India. Hay que decirlo, no esconderlo.
  const tarifaEsRespaldo = !Number.isFinite(parseFloat(cfg.maritimo_directo_per_ft3 ?? ''))

  // Mismo default que calcEnvio (6% por mar), solo para etiquetar la fila del seguro.
  const cfgInsurance = parseFloat(cfg.maritimo_insurance_pct ?? '')
  const insurancePctShown = Number.isFinite(cfgInsurance) ? cfgInsurance : 0.06

  const isEmpty = items.length === 0

  // Venta: presupuestos usan su salePrice (ya sumado); piezas sueltas usan precio de catálogo
  const saleTotal =
    selectedPedidos.reduce((s, ped) => s + ped.saleTotal, 0) +
    manual.reduce((s, c) => s + c.product.price * c.quantity, 0)

  // `fobUsd` es 0 fuera de CBM, así que esto no cambia el aéreo ni el escenario en ft³.
  const shippingEst = calc.airUsd + calc.maritimeUsd + calc.fobUsd
  // Por mar el peso no se cobra: una pieza sin peso cargado no distorsiona nada, pero una
  // sin dimensiones sí, porque el flete ES el volumen.
  const anyMissing = calc.lines.some(l => l.missingDims || (!esMaritimo && l.missingWeight))
  const ratioPct = calc.ratioVW != null ? calc.ratioVW * 100 : null
  const tierHint = airTierHint(calc.chargeableKg, calc.air.costPerKgUsd, calc.air.cajas, calc.air.capKg)

  // Contra qué mar se mide el aéreo. Es CBM salvo que estés mirando a propósito el
  // escenario viejo en ft³.
  //
  // Antes era `esCbm ? calcCbm : calcMaritimo`, y eso tenía un efecto que no se veía: en el
  // modo aéreo —que es el que abre por defecto— `esCbm` es false, así que el titular
  // comparaba contra la cotización VIEJA por pie cúbico. Con la tarifa de respaldo esa sale
  // baratísima, así que la pantalla anunciaba "conviene por mar, ahorrás el 63%" sobre un
  // precio que ya nadie cobra, mientras el marítimo real (con su FOB fijo y su mínimo de
  // 1 m³) costaba siete veces más. Comparar contra el carril que existe hace que una caja
  // chica diga lo que tiene que decir: sola no conviene, hay que consolidarla.
  const calcMar = modo === 'maritimo' ? calcMaritimo : calcCbm
  const ahorroMaritimo = calcAereo.landedUsd - calcMar.landedUsd
  const ahorroPct = calcAereo.landedUsd > 0 ? (ahorroMaritimo / calcAereo.landedUsd) * 100 : 0
  const fmtBound =
    calc.binding === 'weight'
      ? { label: 'Atado por PESO', cls: 'bg-green-100 text-green-700' }
      : { label: 'Atado por VOLUMEN', cls: 'bg-red-100 text-red-700' }

  // Landed por presupuesto
  const landedByPedido = new Map<number, number>()
  for (const l of calc.lines) {
    landedByPedido.set(l.pedidoId, (landedByPedido.get(l.pedidoId) ?? 0) + l.landedUsd)
  }

  function pedidoPieces(ped: SimPedido) {
    return ped.pieceCount
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* ── Izquierda: armar el supuesto envío ──────────────────────────────
          Una sola caja y no tres apiladas. Eran "agregar presupuesto",
          "presupuestos en el supuesto" y "agregar pieza suelta", que es el mismo
          gesto contado tres veces: lo que importa es QUÉ hay adentro y cómo
          sumarle algo. Lo que está adentro va arriba, con su landed al lado;
          agregar es una línea, no una tarjeta. */}
      <div className="space-y-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-gray-900">Qué traés</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Presupuestos ya creados, piezas sueltas, o las dos cosas en la misma caja.
              Nada de esto se guarda.
            </p>
          </div>

          {/* Lo que ya está adentro */}
          {(selectedPedidos.length > 0 || manual.length > 0) && (
            <div className="px-5 pb-3 divide-y divide-gray-50 border-y border-gray-100">
              {selectedPedidos.map(ped => (
                <div key={`p-${ped.id}`} className="flex items-center gap-2 py-2">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0">
                    📄 #{ped.id}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{ped.clientName}</p>
                    <p className="text-[11px] text-gray-400">{pedidoPieces(ped)} piezas · vendido {usd(ped.saleTotal)}</p>
                  </div>
                  <span className="text-sm font-mono text-gray-600 shrink-0">{usd(landedByPedido.get(ped.id) ?? 0)}</span>
                  <button
                    type="button"
                    onClick={() => removePedido(ped.id)}
                    className="text-gray-300 hover:text-red-500 shrink-0 px-1"
                    title="Quitar"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {manual.map(({ product: p, quantity }) => (
                <div key={`m-${p.id}`} className="flex items-center gap-2 py-2">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0">
                    🔩 pieza
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.nameEs}</p>
                    <p className="text-[11px] text-gray-400">
                      {p.bajajCode && <span className="font-mono">{p.bajajCode} · </span>}
                      {p.weightGrams != null ? `${p.weightGrams} g` : <span className="text-amber-600">sin peso</span>}
                    </p>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={e => updateQty(p.id, parseInt(e.target.value) || 1)}
                    className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => removeManual(p.id)}
                    className="text-gray-300 hover:text-red-500 shrink-0 px-1"
                    title="Quitar"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Sumar algo */}
          <div className="px-5 py-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Sumar un presupuesto</label>
              <select
                value=""
                onChange={e => e.target.value !== '' && addPedido(parseInt(e.target.value))}
                disabled={availablePedidos.length === 0}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">
                  {pedidos.length === 0
                    ? 'No hay presupuestos creados todavía'
                    : availablePedidos.length === 0
                      ? 'Ya los agregaste todos'
                      : 'Elegí un presupuesto…'}
                </option>
                {availablePedidos.map(ped => (
                  <option key={ped.id} value={ped.id}>
                    #{ped.id} · {ped.clientName} · {pedidoPieces(ped)} pzas · {ped.status}
                    {ped.envioIds.length > 0 ? ` · ya en envío ${ped.envioIds.map(id => `#${id}`).join(', ')}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative">
              <label className="block text-xs font-medium text-gray-600 mb-1">Sumar una pieza suelta</label>
              <input
                type="text"
                placeholder="Buscar por nombre o código…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {filtered.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg divide-y divide-gray-50 overflow-hidden">
                  {filtered.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addProduct(p)}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-900">{p.nameEs}</span>
                        {p.bajajCode && <span className="ml-2 text-xs font-mono text-gray-400">{p.bajajCode}</span>}
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">
                        {p.weightGrams != null ? `${p.weightGrams} g` : 'sin peso'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Derecha: resultado del cálculo ── */}
      <div className="space-y-4">
        {isEmpty ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400">
            <p className="text-lg">Supuesto vacío</p>
            <p className="text-sm mt-1">Agregá presupuestos o piezas a la izquierda para ver el costo aproximado.</p>
          </div>
        ) : (
          <>
            {/* El veredicto primero. La pregunta que se vino a hacer —"¿por aire o por
                mar?"— estaba contestada en una línea de 11px abajo de tres botones; el
                número de la diferencia es el titular, no una nota al pie. */}
            {calcAereo.landedUsd > 0 && (
              <div
                className={`rounded-xl border p-5 ${
                  ahorroMaritimo >= 0 ? 'bg-green-50 border-green-200' : 'bg-white border-gray-100 shadow-sm'
                }`}
              >
                <p className={`text-lg font-semibold ${ahorroMaritimo >= 0 ? 'text-green-900' : 'text-gray-900'}`}>
                  {ahorroMaritimo >= 0 ? (
                    <>
                      Conviene por <span className="font-bold">mar</span>: ahorrás{' '}
                      <span className="font-mono">{usd(ahorroMaritimo)}</span> ({ahorroPct.toFixed(0)}% del landed).
                    </>
                  ) : (
                    <>
                      Conviene por <span className="font-bold">aire</span>: por mar esta caja sale{' '}
                      <span className="font-mono">{usd(-ahorroMaritimo)}</span> más cara ({(-ahorroPct).toFixed(0)}%).
                    </>
                  )}
                </p>
                <p className={`text-sm mt-0.5 ${ahorroMaritimo >= 0 ? 'text-green-800' : 'text-gray-600'}`}>
                  {usd(calcAereo.landedUsd)} por aire contra {usd(calcMar.landedUsd)} por{' '}
                  {modo === 'maritimo' ? 'el escenario viejo en ft³' : 'el marítimo CBM'} — puestos en Venezuela.
                  {modo !== 'maritimo' && calcCbm.minM3Applied && (
                    <> Esta caja no llena el mínimo de {calcCbm.billableM3.toFixed(2)} m³, así que paga aire: por mar
                    conviene mandarla acompañada, no sola.</>
                  )}
                </p>
              </div>
            )}

            {/* Modo de traída: las dos rutas que existen de verdad */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Modo de traída</h2>
              <div className="grid grid-cols-2 gap-2">
                <ModoButton
                  active={modo === 'aereo'}
                  onClick={() => setModo('aereo')}
                  title="✈️ Aéreo"
                  sub="India → USA en avión, luego mar a VEN. Es el carril de los pedidos."
                  tag="comercial"
                  total={usd(calcAereo.landedUsd)}
                />
                <ModoButton
                  active={modo === 'maritimo_cbm'}
                  onClick={() => { setModo('maritimo_cbm'); setVerLegacy(false) }}
                  title="🚢 Marítimo CBM"
                  sub="Tarifa plana por m³ + FOB fijo de India. Es el carril del stock."
                  tag="real"
                  total={usd(calcCbm.landedUsd)}
                />
              </div>

              {verLegacy ? (
                <div className="mt-2">
                  <ModoButton
                    active={modo === 'maritimo'}
                    onClick={() => setModo('maritimo')}
                    title="🚢 Mar por ft³"
                    sub="Cotización vieja, por pie cúbico. No es una ruta que se pueda contratar hoy."
                    tag="escenario viejo"
                    total={usd(calcMaritimo.landedUsd)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setVerLegacy(true)}
                  className="mt-2 text-xs text-gray-400 hover:text-blue-600"
                >
                  Ver también el escenario viejo por ft³ ({usd(calcMaritimo.landedUsd)})
                </button>
              )}

              {esCbm && calc.cbmRatePerM3 === 0 && (
                <p className="text-xs mt-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                  ⚠️ No hay tarifa por m³ cargada, así que el flete cuenta 0 y este escenario sale
                  falsamente barato. Cargá <span className="font-mono">cbm_rate_usd</span> (y el{' '}
                  <span className="font-mono">cbm_fob_india_usd</span>) en Configuración.
                </p>
              )}

              {modo === 'maritimo' && tarifaEsRespaldo && (
                <p className="text-xs mt-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                  ⚠️ Todavía no cargaste la tarifa marítima: se está usando la de Miami→CCS
                  ({usd(calc.maritimePerFt3)}/ft³), que cubre solo el tramo corto y subestima el flete
                  completo desde India. Cargá <span className="font-mono">maritimo_directo_per_ft3</span> en
                  Configuración para que la comparación valga.
                </p>
              )}
            </div>

            {/* Volumen — en marítimo el flete ES el volumen, el peso no se cobra */}
            {esMaritimo && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Volumen facturable</h2>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-sky-100 text-sky-700">
                    Se cobra VOLUMEN
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Volumen real</p>
                    <p className="text-lg font-bold font-mono text-gray-900">
                      {esCbm ? m3(calc.volumeM3) : ft3(calc.volumeFt3)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Facturable</p>
                    <p className={`text-lg font-bold font-mono ${
                      (esCbm ? calc.minM3Applied : calc.minFt3Applied) ? 'text-amber-600' : 'text-sky-700'
                    }`}>
                      {esCbm ? m3(calc.billableM3) : ft3(calc.billableFt3)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">{esCbm ? 'Tarifa / m³' : 'Tarifa / ft³'}</p>
                    <p className="text-lg font-bold font-mono text-gray-900">
                      {usd(esCbm ? calc.cbmRatePerM3 : calc.maritimePerFt3)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Flete marítimo</p>
                    <p className="text-lg font-bold font-mono text-blue-700">{usd(calc.maritimeUsd)}</p>
                  </div>
                </div>

                {/* Medidor de llenado: la señal de cuándo conviene cerrar el embarque. */}
                {esCbm && (
                  <div className="mt-5">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-gray-500">Llenado del volumen facturable</span>
                      <span className="font-mono font-semibold text-gray-700">{(calc.cbmFillPct * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          calc.cbmFillPct >= 0.9 ? 'bg-green-500' : calc.cbmFillPct >= 0.6 ? 'bg-amber-400' : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(calc.cbmFillPct * 100, 100)}%` }}
                      />
                    </div>
                    {calc.fobUsd > 0 && (
                      <p className="text-xs mt-2 text-gray-600">
                        El FOB de India ({usd(calc.fobUsd)}) es fijo por embarque: hoy pesa{' '}
                        <span className="font-mono text-gray-800">
                          {calc.volumeM3 > 0 ? `${usd(calc.fobUsd / calc.volumeM3)}/m³` : '—'}
                        </span>
                        . Cada pieza que sumes lo diluye.
                      </p>
                    )}
                  </div>
                )}

                <p className="text-xs mt-4 text-gray-500">
                  Peso real de la caja: <span className="font-mono text-gray-700">{kg(calc.realKg)}</span> — por mar
                  no se cobra. Todo el juego de max(peso, volumétrico) y el punto dulce de la tabla escalón
                  de ShipGlobal dejan de aplicar.
                </p>

                {(esCbm ? calc.minM3Applied : calc.minFt3Applied) && (
                  <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                    ⚠️ La caja no llega al mínimo del embarque: pagás{' '}
                    {esCbm ? m3(calc.billableM3) : ft3(calc.billableFt3)} teniendo{' '}
                    {esCbm ? m3(calc.volumeM3) : ft3(calc.volumeFt3)}. Te sobran{' '}
                    <span className="font-mono">
                      {esCbm ? m3(calc.billableM3 - calc.volumeM3) : ft3(calc.billableFt3 - calc.volumeFt3)}
                    </span>
                    {' '}ya pagados — conviene sumar piezas voluminosas antes de embarcar.
                  </p>
                )}

                {anyMissing && (
                  <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                    ⚠️ Hay piezas sin dimensiones cargadas — por mar el flete se calcula sobre el volumen,
                    así que el costo está subestimado.
                  </p>
                )}
              </div>
            )}

            {/* Peso cobrable — solo aéreo */}
            {!esMaritimo && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Peso cobrable aéreo</h2>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${fmtBound.cls}`}>{fmtBound.label}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Peso real (ΣW)</p>
                  <p className={`text-lg font-bold font-mono ${calc.binding === 'weight' ? 'text-green-700' : 'text-gray-900'}`}>{kg(calc.realKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Volumétrico (ΣV)</p>
                  <p className={`text-lg font-bold font-mono ${calc.binding === 'volume' ? 'text-red-700' : 'text-gray-900'}`}>{kg(calc.volKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Cobrable max(W,V)</p>
                  <p className="text-lg font-bold font-mono text-blue-700">{kg(calc.chargeableKg)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Aéreo / kg</p>
                  <p className="text-lg font-bold font-mono text-gray-900">{usd(calc.airPerKgUsd)}</p>
                </div>
              </div>
              {/* Utilización volumétrica */}
              {ratioPct != null && (
                <div className="mt-5">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-500">Utilización volumétrica (V/W) — meta 80–100%</span>
                    <span className="font-mono font-semibold text-gray-700">{ratioPct.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden relative">
                    <div className="absolute inset-y-0 bg-green-100" style={{ left: '80%', right: '0%' }} />
                    <div
                      className={`h-full rounded-full ${calc.binding === 'volume' ? 'bg-red-500' : ratioPct >= 80 ? 'bg-green-500' : 'bg-amber-400'}`}
                      style={{ width: `${Math.min(ratioPct, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs mt-2 text-gray-600">
                    {calc.binding === 'volume'
                      ? '⚠️ Te pasaste por volumen: el carrier cobra el volumétrico (> peso). Agregá piezas pesadas para volver a estar atado por peso, o tus precios fijos subcostean.'
                      : ratioPct >= 80
                        ? '✓ Buena utilización: estás llenando el volumen que ya pagás por peso.'
                        : 'Desperdiciás volumen pagado. Podés colar piezas voluminosas y ligeras (plásticos) casi gratis hasta llegar al 100%.'}
                  </p>
                </div>
              )}

              {tierHint && (
                <p className={`text-xs mt-3 px-3 py-2 rounded-lg ${tierHint.tone === 'good' ? 'bg-green-50 text-green-700' : tierHint.tone === 'warn' ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-700'}`}>
                  {tierHint.text}
                </p>
              )}

              {anyMissing && (
                <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                  ⚠️ Algunas piezas no tienen peso o dimensiones cargadas — el cálculo las subestima.
                </p>
              )}
            </div>
            )}

            {/* Desglose de costo */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
                Costo aproximado (landed) · {esCbm ? 'marítimo CBM' : esMaritimo ? 'marítimo directo' : 'aéreo'}
              </h2>
              <dl className="space-y-2 text-sm">
                <Row label="Costo de producto (India)" value={usd(calc.productCostUsd)} />
                {esCbm ? (
                  <>
                    <Row
                      label={`Marítimo India→VEN · ${calc.billableM3.toFixed(3)} m³ × ${usd(calc.cbmRatePerM3)}`}
                      value={usd(calc.maritimeUsd)}
                    />
                    <Row label="FOB India (fijo por embarque)" value={usd(calc.fobUsd)} />
                  </>
                ) : esMaritimo ? (
                  <>
                    <Row
                      label={`Marítimo India→VEN · ${calc.billableFt3.toFixed(2)} ft³ × ${usd(calc.maritimePerFt3)}`}
                      value={usd(calc.maritimeUsd)}
                    />
                    <Row label={`Seguro (${(insurancePctShown * 100).toFixed(0)}% del producto)`} value={usd(calc.insuranceUsd)} />
                    <Row label="Gastos fijos (origen / destino)" value={usd(calc.processingUsd)} />
                  </>
                ) : (
                  <>
                    <Row
                      label={`Aéreo India→USA · ${calc.air.chargeableKg.toFixed(1)} kg cobrables${calc.air.cajas > 1 ? ` en ${calc.air.cajas} cajas` : ''}`}
                      value={usd(calc.airUsd)}
                    />
                    <Row label="Marítimo USA→VEN (volumen)" value={usd(calc.maritimeUsd)} />
                    <Row label="Seguro" value={usd(calc.insuranceUsd)} />
                    <Row label="Processing" value={usd(calc.processingUsd)} />
                  </>
                )}
                <div className="flex justify-between pt-3 mt-2 border-t-2 border-gray-200">
                  <dt className="font-bold text-gray-900">Costo total landed</dt>
                  <dd className="font-bold text-xl font-mono text-blue-700">{usd(calc.landedUsd)}</dd>
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <dt>{esCbm ? 'Solo flete (marítimo + FOB)' : esMaritimo ? 'Solo flete (marítimo)' : 'Solo flete (aéreo + marítimo)'}</dt>
                  <dd className="font-mono">{usd(shippingEst)}</dd>
                </div>
                {saleTotal > 0 && (
                  <>
                    <Row label="Venta (suma de presupuestos)" value={usd(saleTotal)} />
                    <div className="flex justify-between">
                      <dt className="font-semibold text-gray-700">Margen bruto</dt>
                      <dd className={`font-semibold font-mono ${saleTotal - calc.landedUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {usd(saleTotal - calc.landedUsd)}{' '}
                        <span className="text-xs text-gray-400">
                          ({((1 - calc.landedUsd / saleTotal) * 100).toFixed(0)}%)
                        </span>
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>

            {/* Desglose por pieza */}
            <details className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <summary className="px-6 py-3 bg-gray-50 cursor-pointer text-sm font-semibold text-gray-500 uppercase tracking-wide">
                Desglose por pieza ({calc.lines.length})
              </summary>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-6 py-2 font-semibold">Pieza</th>
                    {esMaritimo ? (
                      <th className="text-right px-3 py-2 font-semibold">ft³</th>
                    ) : (
                      <>
                        <th className="text-right px-3 py-2 font-semibold">Real</th>
                        <th className="text-right px-3 py-2 font-semibold">Vol.</th>
                        <th className="text-right px-3 py-2 font-semibold">Aéreo</th>
                      </>
                    )}
                    <th className="text-right px-3 py-2 font-semibold">Marít.</th>
                    <th className="text-right px-4 py-2 font-semibold">Landed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {calc.lines.map((l, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-2.5">
                        <span className="text-gray-900">{l.name}</span>
                        {l.quantity > 1 && <span className="text-xs text-gray-400"> ×{l.quantity}</span>}
                      </td>
                      {esMaritimo ? (
                        <td className="px-3 py-2.5 text-right font-mono text-gray-600">{l.ft3.toFixed(3)}</td>
                      ) : (
                        <>
                          <td className="px-3 py-2.5 text-right font-mono text-gray-600">{l.realKg.toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-gray-600">{l.volKg.toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-gray-600">{usd(l.airUsd)}</td>
                        </>
                      )}
                      <td className="px-3 py-2.5 text-right font-mono text-gray-600">{usd(l.maritimeUsd)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-gray-900">{usd(l.landedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

// Botón de modo que además funciona como comparador: muestra el landed de SU escenario,
// esté activo o no, para poder leer los dos números sin cambiar de pestaña.
function ModoButton({
  active, onClick, title, sub, tag, total,
}: {
  active: boolean
  onClick: () => void
  title: string
  sub: string
  tag: string
  total: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-4 py-3 rounded-lg border-2 transition-colors ${
        active
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold ${active ? 'text-blue-900' : 'text-gray-700'}`}>{title}</span>
        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
          active ? 'bg-blue-200 text-blue-800' : 'bg-gray-100 text-gray-500'
        }`}>
          {tag}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-0.5 leading-snug">{sub}</p>
      <p className={`mt-2 font-mono font-bold ${active ? 'text-blue-700' : 'text-gray-400'}`}>{total}</p>
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono text-gray-800">{value}</dd>
    </div>
  )
}
