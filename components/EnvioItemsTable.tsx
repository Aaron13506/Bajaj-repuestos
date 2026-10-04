'use client'

import Link from 'next/link'
import { Fragment, useOptimistic, useRef, useState, useTransition } from 'react'
import {
  SHIPPING_STATUSES,
  routeFor,
  routeStages,
  normalizeToRoute,
  nextStatus,
  statusIndex,
  isDelivered,
  pasosRestantes,
  shippingStatusMeta,
  stageSummary,
} from '@/lib/shipping-status'
import type { Inbound } from '@/lib/inbound'
import { groupBundlePieces, type BundlePiece } from '@/lib/bundle'
import { limpiarNombre } from '@/lib/utils'
import type { CambioItem } from '@/app/(pages)/envios/actions'

export interface EnvioItemRow {
  id: number
  pedidoId: number
  clientName: string
  nombre: string
  bajajCode: string | null
  quantity: number
  piezas: BundlePiece[]
  landed: number
  venta: number
  shippingStatus: string
  // El proveedor cotizó esta pieza puesta en Venezuela: no viaja en la caja y su ruta
  // salta el pipeline entero. Es lo único que puede diferir entre líneas de una misma caja.
  isLanded: boolean
  shippingStatusAt: string | null
  // Unidades de stock propio que esta línea mueve al entregarse (0 si es de un cliente, o un
  // conjunto, que no acredita stock). Sirve para avisar antes de un movimiento masivo.
  stockUnidades: number
  // Piezas de la línea sin peso / sin medidas cargados: el cálculo del flete las subestima.
  sinPeso: number
  sinMedidas: number
}

interface Props {
  envioId: number
  items: EnvioItemRow[]
  // Por dónde entra a USA la caja entera. Todas sus líneas lo heredaron al entrar, así que
  // define las etapas que ofrece el select de estado: una caja que despacha directo no
  // pasa por Shoppre, y ofrecer esas etapas sería prometer un estado que no va a llegar.
  inbound: Inbound
  guardar: (envioId: number, cambios: CambioItem[]) => Promise<void>
  // Se quita el presupuesto COMPLETO, no piezas sueltas: el presupuesto es lo que se le
  // vendió al cliente y no se parte. O viaja entero en esta caja, o no viaja.
  quitar: (envioId: number, pedidoId: number) => Promise<void>
}

// Aviso ámbar de piezas sin peso o sin medidas. No dice cuáles: lleva al presupuesto, que es
// donde está el loader de medidas.
function FaltantesBadge({ its, href }: { its: EnvioItemRow[]; href: string }) {
  const sinPeso = its.reduce((s, it) => s + it.sinPeso, 0)
  const sinMedidas = its.reduce((s, it) => s + it.sinMedidas, 0)
  if (sinPeso === 0 && sinMedidas === 0) return null
  const partes = [sinPeso > 0 && `${sinPeso} sin peso`, sinMedidas > 0 && `${sinMedidas} sin medidas`].filter(Boolean)
  return (
    <Link
      href={href}
      title="Estas piezas no suman al flete calculado. Cargá peso y medidas en el presupuesto."
      className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200"
    >
      {partes.join(' · ')}
    </Link>
  )
}

const usd = (n: number) => `$${n.toFixed(2)}`
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })

// Cabecera de columna ordenable. La flecha solo aparece en la columna activa, para que se
// vea de un vistazo por qué está ordenada la tabla.
function Th({
  campo,
  orden,
  onClick,
  className = '',
  titulo,
  children,
}: {
  campo: Campo
  orden: { campo: Campo; dir: Direccion }
  onClick: (campo: Campo) => void
  className?: string
  titulo?: string
  children: React.ReactNode
}) {
  const activa = orden.campo === campo
  return (
    <th className={`py-2 font-semibold ${className}`}>
      <button
        type="button"
        onClick={() => onClick(campo)}
        title={titulo ?? 'Ordenar'}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-800 transition-colors ${
          activa ? 'text-gray-800' : 'text-gray-500'
        }`}
      >
        {children}
        <span className={activa ? 'text-blue-600' : 'text-gray-300'}>
          {activa ? (orden.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}

// Valor de un campo cuando TODAS las filas coinciden; `undefined` si están mezcladas.
// Es lo que permite que la cabecera muestre el estado real del presupuesto en vez de un
// "sin cambio" permanente: si las 3 piezas están en Shoppre, arriba dice Shoppre.
function comun<T>(valores: T[]): T | undefined {
  if (valores.length === 0) return undefined
  const primero = valores[0]
  return valores.every(v => v === primero) ? primero : undefined
}

const MIXTO = '__mixto__'

type Campo = 'cliente' | 'landed' | 'venta' | 'estado'
type Direccion = 'asc' | 'desc'

// Por defecto se ordena por estado ascendente = los que están más cerca de entregarse
// arriba. Es el orden útil para trabajar: lo que está por caer se revisa primero.
const ORDEN_INICIAL: { campo: Campo; dir: Direccion } = { campo: 'estado', dir: 'asc' }

export default function EnvioItemsTable({
  envioId,
  items,
  inbound,
  guardar,
  quitar,
}: Props) {
  // Estado local de los selects. La base vive en Supabase remoto, así que cada guardado
  // son cientos de ms: la UI no los espera. Se pinta el cambio al instante y el guardado
  // va por detrás; si falla, se revierte y se avisa.
  const [editado, setEditado] = useState<Record<number, { shippingStatus: string }>>({})
  // Presupuestos sacados de la caja, para que desaparezcan antes de que el server confirme.
  const [quitados, setQuitados] = useOptimistic<number[], number>([], (prev, id) => [...prev, id])
  const [abiertos, setAbiertos] = useState<number[]>([])
  const [orden, setOrden] = useState(ORDEN_INICIAL)
  const [guardando, startGuardar] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [guardadoOk, setGuardadoOk] = useState(false)
  const [incluirNoCompradas, setIncluirNoCompradas] = useState(false)
  // Qué se salteó en el último movimiento masivo (no es un error: se avisa que se salteaba).
  const [aviso, setAviso] = useState<string | null>(null)
  // `guardando` recién se ve en el render siguiente: dos cambios seguidos antes de eso pasarían
  // los dos. Con el candado en un ref el segundo se descarta en el momento. (El servidor igual
  // no suma el stock dos veces: ver saveItemChanges.)
  const enVuelo = useRef(false)

  // Valores efectivos: lo editado localmente gana sobre lo que vino del servidor.
  const valorDe = (it: EnvioItemRow) => editado[it.id] ?? { shippingStatus: it.shippingStatus }

  // La ruta sale de cómo entra la CAJA, más el isLanded de la línea: una pieza que el
  // proveedor manda puesta en Venezuela no viaja adentro, así que salta el pipeline.
  const rutaDe = (it: EnvioItemRow) => routeFor(inbound, it.isLanded)

  const visibles = items.filter(it => !quitados.includes(it.pedidoId))
  // Las etapas de la ruta de la caja (la de sus líneas que sí viajan).
  const etapasCaja = routeStages(routeFor(inbound, false))

  function aplicar(cambios: CambioItem[]) {
    if (cambios.length === 0) return
    enVuelo.current = true
    setError(null)
    setGuardadoOk(false)
    startGuardar(async () => {
      try {
        await guardar(envioId, cambios)
        setGuardadoOk(true)
      } catch {
        // Se devuelve la UI a lo que dice el servidor: mejor un salto visual que dejarte
        // creyendo que guardaste algo que no se guardó.
        setEditado(prev => {
          const copia = { ...prev }
          for (const c of cambios) delete copia[c.id]
          return copia
        })
        setError('No se pudo guardar. Revisá la conexión y probá de nuevo.')
      } finally {
        enVuelo.current = false
      }
    })
  }

  // Lleva cada fila a SU destino: pinta primero, guarda después. Sirve igual para un select
  // suelto (una fila), la cabecera de un presupuesto (todas las suyas) y el movimiento de la
  // caja entera, donde el destino puede diferir por línea (avanzar un paso).
  function aplicarPares(pares: { it: EnvioItemRow; destino: string }[]) {
    // Con un guardado en vuelo no se pinta ni se manda nada: pintar sin guardar dejaría la
    // fila mostrando un estado que el servidor nunca recibió.
    if (enVuelo.current) return
    const cambios: CambioItem[] = []
    const parche: Record<number, { shippingStatus: string }> = {}

    for (const { it, destino } of pares) {
      const actual = valorDe(it)
      // Se normaliza a la ruta de la fila antes de pintarlo, para no mostrar una etapa que
      // esa ruta no tiene y que después "salte" al recargar.
      const shippingStatus = normalizeToRoute(destino, rutaDe(it))
      if (shippingStatus === actual.shippingStatus) continue
      parche[it.id] = { shippingStatus }
      cambios.push({ id: it.id, shippingStatus })
    }

    if (cambios.length === 0) return
    setEditado(prev => ({ ...prev, ...parche }))
    aplicar(cambios)
  }

  const aplicarA = (filas: EnvioItemRow[], patch: { shippingStatus: string }) =>
    aplicarPares(filas.map(it => ({ it, destino: patch.shippingStatus })))

  // Mueve la caja entera. `destino` null = avanzar un paso cada línea según su ruta.
  //
  // Se saltea lo que no corresponde en vez de arrastrarlo: una línea que el proveedor manda
  // puesta en Venezuela no tiene la etapa "camino a USA", y normalizarla la llevaría a
  // "en Venezuela" — adelantaría algo que nunca viajó. Y lo no comprado no puede estar "en
  // camino", así que no se toca salvo que se pida.
  function moverTodo(destino: string | null) {
    if (enVuelo.current) return
    const pares: { it: EnvioItemRow; destino: string }[] = []
    let sinEtapa = 0
    let sinComprar = 0
    for (const it of visibles) {
      const actual = valorDe(it).shippingStatus
      const ruta = rutaDe(it)
      const hacia = destino ?? nextStatus(actual, ruta)
      if (hacia == null) continue
      if (!routeStages(ruta).some(s => s.value === hacia)) { sinEtapa++; continue }
      if (actual === 'pendiente' && !incluirNoCompradas && hacia !== 'pendiente') { sinComprar++; continue }
      if (hacia === actual) continue
      pares.push({ it, destino: hacia })
    }

    if (pares.length === 0) {
      setError(
        sinComprar > 0
          ? 'Todo lo que se podía mover está sin comprar. Tildá "incluir no compradas" si es a propósito.'
          : 'No hay líneas para mover a esa etapa.',
      )
      return
    }

    // Lo que pide confirmación: entregar o des-entregar stock propio (toca Product.stock) e ir
    // para atrás. Ambos son fáciles de hacer sin querer sobre 40 líneas de un click.
    const entran = pares.filter(p => isDelivered(p.destino) && !isDelivered(valorDe(p.it).shippingStatus))
    const salen = pares.filter(p => !isDelivered(p.destino) && isDelivered(valorDe(p.it).shippingStatus))
    const uEntran = entran.reduce((s, p) => s + p.it.stockUnidades, 0)
    const uSalen = salen.reduce((s, p) => s + p.it.stockUnidades, 0)
    const atras = pares.filter(p => statusIndex(p.destino) < statusIndex(valorDe(p.it).shippingStatus)).length

    const avisos: string[] = []
    if (uEntran > 0) avisos.push(`Suma ${uEntran} u. al stock propio.`)
    if (uSalen > 0) avisos.push(`Resta ${uSalen} u. del stock propio.`)
    if (atras > 0) avisos.push(`${atras} ${atras === 1 ? 'línea retrocede' : 'líneas retroceden'} de etapa.`)
    if (avisos.length > 0 && !confirm(`Vas a mover ${pares.length} líneas.\n\n${avisos.join('\n')}\n\n¿Seguro?`)) return

    aplicarPares(pares)
    const notas: string[] = []
    if (sinEtapa > 0) notas.push(`${sinEtapa} ${sinEtapa === 1 ? 'línea no tiene' : 'líneas no tienen'} esa etapa y quedaron como estaban`)
    if (sinComprar > 0) notas.push(`${sinComprar} sin comprar no se movieron`)
    setAviso(notas.length > 0 ? notas.join(' · ') : null)
  }

  function quitarPresupuesto(pedidoId: number, clientName: string, cantidad: number) {
    if (!confirm(
      `¿Sacar el presupuesto de ${clientName} de este envío? ` +
      `Se quitan sus ${cantidad} ${cantidad === 1 ? 'conjunto' : 'conjuntos'} y queda libre para otra caja. ` +
      `El presupuesto en sí no se toca.`
    )) return

    setError(null)
    startGuardar(async () => {
      setQuitados(pedidoId)
      try {
        await quitar(envioId, pedidoId)
      } catch {
        setError('No se pudo quitar el presupuesto.')
      }
    })
  }

  // Pasos que le faltan a un ítem según SU ruta (la de su proveedor actual).
  const pasosDe = (it: EnvioItemRow) => pasosRestantes(valorDe(it).shippingStatus, rutaDe(it))

  // Comparador único para los dos niveles: se ordenan los presupuestos y también las
  // piezas dentro de cada uno con el mismo criterio, así lo que ves al expandir sigue la
  // misma lógica que la lista de arriba.
  function comparar(
    a: { cliente: string; landed: number; venta: number; pasos: number; id: number },
    b: { cliente: string; landed: number; venta: number; pasos: number; id: number },
  ) {
    const signo = orden.dir === 'asc' ? 1 : -1
    let d = 0
    switch (orden.campo) {
      case 'cliente': d = a.cliente.localeCompare(b.cliente); break
      case 'landed':  d = a.landed - b.landed; break
      case 'venta':   d = a.venta - b.venta; break
      case 'estado':  d = a.pasos - b.pasos; break
    }
    // Empate: por id, para que el orden no baile entre renders.
    return d !== 0 ? d * signo : a.id - b.id
  }

  const porPedidoRaw = new Map<number, EnvioItemRow[]>()
  for (const it of visibles) {
    porPedidoRaw.set(it.pedidoId, [...(porPedidoRaw.get(it.pedidoId) ?? []), it])
  }

  // Un presupuesto está tan lejos del final como su pieza MÁS atrasada: no se entrega a
  // medias. Por eso el grupo se ordena por el máximo de pasos restantes, no el mínimo.
  const grupos = [...porPedidoRaw.entries()]
    .map(([pedidoId, its]) => ({
      pedidoId,
      its: [...its].sort((x, y) =>
        comparar(
          { cliente: x.nombre, landed: x.landed, venta: x.venta, pasos: pasosDe(x), id: x.id },
          { cliente: y.nombre, landed: y.landed, venta: y.venta, pasos: pasosDe(y), id: y.id },
        )
      ),
      landed: its.reduce((s, it) => s + it.landed, 0),
      venta: its.reduce((s, it) => s + it.venta, 0),
      pasos: Math.max(...its.map(pasosDe)),
    }))
    .sort((a, b) =>
      comparar(
        { cliente: a.its[0].clientName, landed: a.landed, venta: a.venta, pasos: a.pasos, id: a.pedidoId },
        { cliente: b.its[0].clientName, landed: b.landed, venta: b.venta, pasos: b.pasos, id: b.pedidoId },
      )
    )

  const comprados = visibles.filter(it => valorDe(it).shippingStatus !== 'pendiente').length
  const todoAbierto = abiertos.length === grupos.length && grupos.length > 0

  // Click en una columna: alterna asc/desc si ya estaba activa, si no la activa con el
  // sentido más útil por defecto (nombres A→Z, números y pasos de menor a mayor).
  function ordenarPor(campo: Campo) {
    setOrden(prev =>
      prev.campo === campo
        ? { campo, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { campo, dir: 'asc' }
    )
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
      <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Ítems en el envío ({visibles.length}) · {comprados} comprados
        </h2>
        <div className="flex items-center gap-4 text-xs flex-wrap justify-end">
          {visibles.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                disabled={guardando}
                value=""
                onChange={e => { if (e.target.value) moverTodo(e.target.value) }}
                title="Lleva todas las líneas de la caja a la misma etapa"
                className="border border-gray-300 rounded-lg px-2 py-1 text-xs bg-white"
              >
                <option value="">Mover todo a…</option>
                {etapasCaja.map(s => (
                  <option key={s.value} value={s.value}>{s.icon} {s.label}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={guardando}
                onClick={() => moverTodo(null)}
                title="Cada línea pasa a la etapa siguiente de su ruta"
                className="px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-white disabled:opacity-50"
              >
                Avanzar todo un paso →
              </button>
              <label className="flex items-center gap-1 text-gray-500" title="Por defecto lo que falta comprar no se mueve">
                <input
                  type="checkbox"
                  checked={incluirNoCompradas}
                  onChange={e => setIncluirNoCompradas(e.target.checked)}
                  className="rounded border-gray-300"
                />
                incluir no compradas
              </label>
            </div>
          )}
          <button
            type="button"
            onClick={() => setAbiertos(todoAbierto ? [] : grupos.map(g => g.pedidoId))}
            className="text-blue-600 hover:underline"
          >
            {todoAbierto ? 'Contraer todo' : 'Expandir todo'}
          </button>
          {error ? (
            <span className="text-red-600 font-medium">{error}</span>
          ) : guardando ? (
            <span className="text-gray-400">Guardando…</span>
          ) : guardadoOk ? (
            <span className="text-green-600 font-medium">✓ Guardado</span>
          ) : (
            <span className="text-gray-300">Los cambios se guardan solos</span>
          )}
        </div>
      </div>
      {aviso && (
        <p className="px-6 py-2 text-xs text-gray-600 bg-amber-50 border-b border-amber-100">{aviso}</p>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
            <Th campo="cliente" orden={orden} onClick={ordenarPor} className="text-left px-6">Pieza</Th>
            <Th campo="landed" orden={orden} onClick={ordenarPor} className="text-right px-3 w-28">Landed</Th>
            <Th campo="venta" orden={orden} onClick={ordenarPor} className="text-right px-3 w-28">Venta</Th>
            {/* Ancho suficiente para "Pendiente de comprar" sin recortar. */}
            <Th
              campo="estado"
              orden={orden}
              onClick={ordenarPor}
              className="text-left px-3 w-60"
              titulo="Ordena por pasos que faltan para entregar"
            >
              Estado
            </Th>
            <th className="px-4 py-2 w-20" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {grupos.map(({ pedidoId, its, landed: landedGrupo, venta: ventaGrupo }) => {
            const abierto = abiertos.includes(pedidoId)
            const resumen = stageSummary(its.map(it => ({ shippingStatus: valorDe(it).shippingStatus })))
            // Si todas las filas coinciden, la cabecera muestra ese valor; si no, "mixto".
            const statusComun = comun(its.map(it => valorDe(it).shippingStatus))
            // Las etapas ofrecidas arriba son las de la ruta común del grupo; si adentro
            // hay piezas que no viajan (landed), se ofrecen todas y cada fila se normaliza.
            const rutaComun = comun(its.map(it => rutaDe(it)))
            const rutaGrupo = rutaComun ?? null

            return (
              <Fragment key={pedidoId}>
                <tr className="bg-gray-50/80 border-t border-gray-200">
                  <td className="px-6 py-2">
                    <button
                      type="button"
                      onClick={() => setAbiertos(prev =>
                        prev.includes(pedidoId) ? prev.filter(id => id !== pedidoId) : [...prev, pedidoId]
                      )}
                      className="flex items-center gap-2 text-left group whitespace-nowrap"
                    >
                      <span className={`text-gray-400 text-[10px] transition-transform shrink-0 ${abierto ? 'rotate-90' : ''}`}>
                        ▶
                      </span>
                      <span className="text-sm font-semibold text-gray-800 group-hover:text-blue-600">
                        {its[0].clientName}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        #{pedidoId} · {its.length} {its.length === 1 ? 'conjunto' : 'conjuntos'}
                      </span>
                      {resumen && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${resumen.lead.badge}`}>
                          {resumen.lead.icon} {resumen.comprados}/{resumen.total}
                        </span>
                      )}
                    </button>
                    {/* El flete se calcula con lo que el catálogo sabe de cada pieza: sin peso o
                        sin medidas la suma queda corta. El loader de medidas está en el
                        presupuesto. */}
                    <FaltantesBadge its={its} href={`/presupuestos/${pedidoId}`} />
                  </td>
                  {/* Totales del presupuesto: cuando está contraído siguen visibles. */}
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">{usd(landedGrupo)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">{usd(ventaGrupo)}</td>
                  <td className="px-3 py-2">
                    <select
                      disabled={guardando}
                      value={statusComun === undefined ? MIXTO : statusComun}
                      onChange={e => {
                        if (e.target.value === MIXTO) return
                        aplicarA(its, { shippingStatus: e.target.value })
                      }}
                      className={`w-full rounded-full px-2 py-1 text-[11px] font-semibold border-0 cursor-pointer focus:ring-2 focus:ring-blue-500 ${
                        statusComun !== undefined ? shippingStatusMeta(statusComun).badge : 'bg-white text-gray-500 border border-gray-300'
                      }`}
                    >
                      {statusComun === undefined && <option value={MIXTO}>— mixto —</option>}
                      {(rutaGrupo ? routeStages(rutaGrupo) : SHIPPING_STATUSES).map(s => (
                        <option key={s.value} value={s.value}>{s.icon} {s.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => quitarPresupuesto(pedidoId, its[0].clientName, its.length)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Quitar
                    </button>
                  </td>
                </tr>

                {abierto && its.map(it => {
                  const v = valorDe(it)
                  const ruta = rutaDe(it)
                  const esLanded = it.isLanded
                  return (
                    <tr key={it.id} className="hover:bg-gray-50 align-top">
                      <td className="px-6 py-3 pl-12">
                        <p>
                          <span className="text-gray-900 font-medium">{limpiarNombre(it.nombre)}</span>
                          {it.quantity > 1 && <span className="text-xs text-gray-400"> ×{it.quantity}</span>}
                          {it.bajajCode && (
                            <span className="ml-2 font-mono text-[10px] text-gray-400">{it.bajajCode}</span>
                          )}
                          {esLanded && (
                            <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                              no viaja
                            </span>
                          )}
                          {it.stockUnidades > 0 && (
                            <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">
                              stock propio
                            </span>
                          )}
                          <FaltantesBadge its={[it]} href={`/presupuestos/${it.pedidoId}`} />
                        </p>
                        {/* Las piezas del conjunto: lo que realmente se le pide al
                            proveedor. El ensamble por sí solo no se compra. */}
                        {it.piezas.length > 0 && (
                          <div className="mt-1.5 ml-1 pl-3 border-l-2 border-gray-100 space-y-1.5">
                            {groupBundlePieces(it.piezas).map(([grupo, ps]) => (
                              <div key={grupo}>
                                {grupo !== '—' && (
                                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                    {limpiarNombre(grupo)}
                                  </p>
                                )}
                                <ul className="space-y-0.5">
                                  {ps.map((p, i) => (
                                    <li key={i} className="text-xs text-gray-600">
                                      <span className="font-mono font-semibold text-gray-500">
                                        {p.quantity * it.quantity}×
                                      </span>{' '}
                                      {limpiarNombre(p.nameEs)}
                                      {p.bajajCode && (
                                        <span className="ml-1.5 font-mono text-[10px] text-gray-400">
                                          {p.bajajCode}
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-gray-700">{usd(it.landed)}</td>
                      <td className="px-3 py-3 text-right font-mono text-gray-700">{usd(it.venta)}</td>
                      <td className="px-3 py-3">
                        <select
                          disabled={guardando}
                          value={v.shippingStatus}
                          onChange={e => aplicarA([it], { shippingStatus: e.target.value })}
                          className={`w-full text-xs font-semibold rounded-full pl-2.5 pr-6 py-1 border-0 cursor-pointer focus:ring-2 focus:ring-blue-500 ${shippingStatusMeta(v.shippingStatus).badge}`}
                        >
                          {routeStages(ruta).map(s => (
                            <option key={s.value} value={s.value}>{s.icon} {s.label}</option>
                          ))}
                        </select>
                        {it.shippingStatusAt && (
                          <p className="text-[10px] text-gray-400 mt-1">desde {fecha(it.shippingStatusAt)}</p>
                        )}
                      </td>
                      {/* Sin acción por fila: una pieza no se saca sola del envío. */}
                      <td className="px-4 py-3" />
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {visibles.length === 0 && (
        <p className="px-6 py-8 text-center text-sm text-gray-400">
          No quedan ítems en este envío.
        </p>
      )}
    </div>
  )
}
