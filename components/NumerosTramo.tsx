'use client'

import { Fragment, useState, type ReactNode } from 'react'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import ElegirCourier from '@/components/ElegirCourier'
import type { ActionResult } from '@/lib/action-result'
import { MAX_TRACKINGS_POR_TRAMO, TRAMO_TRACKING_META, type TramoTracking } from '@/lib/tracking'
import { fechaCourier, metaEstado, type Checkpoint, type Courier } from '@/lib/ship24'
import { esCodigoOneway, ONEWAY_CODE, ONEWAY_NOMBRE } from '@/lib/oneway'

export type NumeroGuardado = {
  id: number
  tramo: TramoTracking
  numero: string
  transportista: string | null
  courierCode: string | null
  estado: string | null
  subestado: string | null
  ultimoEvento: string | null
  ultimoEventoEn: string | null
  eventos: Checkpoint[]
  /** Ya formateado en hora de Venezuela (lo arma el servidor). */
  consultado: string | null
  errorSeguimiento: string | null
}

// Los números de UN tramo de la caja: la lista con lo que dice Ship24 de cada uno, y
// «Añadir número», «Editar» y «Quitar» en el mismo renglón, sin ventana encima.
//
// `guardarTrackings` reemplaza TODOS los tramos con lo que manda el form, así que cada form
// lleva ocultos los demás números de la caja tal como están guardados, en su orden, y solo el
// renglón tocado va visible (o falta, si se quita). La página lo monta con una `key` que cambia
// con lo guardado: después de guardar arranca de nuevo, sin nada abierto.
export default function NumerosTramo({ tramo, titulo, sub, todos, couriers, guardar, acciones }: {
  tramo: TramoTracking
  titulo: string
  sub: string
  /** Todos los números de la caja, de todos los tramos. */
  todos: NumeroGuardado[]
  couriers: Courier[]
  guardar: (formData: FormData) => Promise<ActionResult>
  /** Junto a «Añadir número»: «Actualizar trackings» de Ship24/One Way. */
  acciones?: ReactNode
}) {
  const [editando, setEditando] = useState<number | 'nuevo' | null>(null)
  const [quitando, setQuitando] = useState<number | null>(null)
  const lista = todos.filter(t => t.tramo === tramo)
  const lleno = lista.length >= MAX_TRACKINGS_POR_TRAMO
  const meta = TRAMO_TRACKING_META[tramo]
  const idTitulo = `numeros-${tramo}-titulo`

  function cerrar() { setEditando(null); setQuitando(null) }

  return (
    <section aria-labelledby={idTitulo} className="bg-white rounded-xl shadow-sm border border-gray-100 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 sm:px-6 py-4 border-b border-gray-100">
        <div className="min-w-0 flex-1 basis-64">
          <h3 id={idTitulo} className="text-base font-semibold text-gray-900">{titulo}</h3>
          <p className="text-sm text-gray-600">{sub}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
        {acciones}
        <button
          type="button"
          onClick={() => { setQuitando(null); setEditando('nuevo') }}
          disabled={lleno || editando === 'nuevo'}
          className="shrink-0 min-h-9 px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {lleno ? `Máximo ${MAX_TRACKINGS_POR_TRAMO} números` : '+ Añadir número'}
        </button>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-4">
        {lista.length === 0 && editando !== 'nuevo' && (
          <p className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-600">
            Sin números todavía. Cuando despachen, tocá «Añadir número» y pegá el que te llega por correo.
          </p>
        )}
        {(lista.length > 0 || editando === 'nuevo') && (
          <ul className="space-y-2.5">
            {lista.map(t => (
              <li key={t.id} className="rounded-lg bg-gray-50 px-4 py-3">
                {editando === t.id ? (
                  <Edicion
                    tramo={tramo} todos={todos} reemplaza={t.id} couriers={couriers} guardar={guardar}
                    inicial={t} placeholder={meta.ejemplo} transportista={meta.transportista} onCancelar={cerrar}
                  />
                ) : quitando === t.id ? (
                  <FormConResultado action={guardar} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Ocultos filas={todos.filter(o => o.id !== t.id)} />
                    <p className="text-sm text-gray-800 min-w-0 basis-full sm:basis-auto sm:flex-1">
                      ¿Quitar <span className="font-mono font-semibold break-all">{t.numero}</span>? Se borra de la caja con su seguimiento.
                    </p>
                    <PendingButton
                      pendingLabel="Quitando…"
                      className="min-h-9 px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50"
                    >
                      Quitar
                    </PendingButton>
                    <button
                      type="button" autoFocus onClick={cerrar}
                      className="min-h-9 px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50"
                    >
                      Cancelar
                    </button>
                  </FormConResultado>
                ) : (
                  <Renglon
                    t={t}
                    onEditar={() => { setQuitando(null); setEditando(t.id) }}
                    onQuitar={() => { setEditando(null); setQuitando(t.id) }}
                  />
                )}
              </li>
            ))}
            {editando === 'nuevo' && (
              <li className="rounded-lg border border-blue-200 bg-blue-50/40 px-4 py-3">
                <Edicion
                  tramo={tramo} todos={todos} reemplaza={null} couriers={couriers} guardar={guardar}
                  inicial={null} placeholder={meta.ejemplo} transportista={meta.transportista} onCancelar={cerrar}
                />
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  )
}

function Chip({ t }: { t: NumeroGuardado }) {
  const m = metaEstado(t.estado)
  const [texto, cls] = !t.courierCode ? ['Solo anotado', 'bg-gray-100 text-gray-700']
    : t.errorSeguimiento ? ['No se sigue', 'bg-red-100 text-red-700']
      : m ? [m.label, m.color]
        : ['Por consultar', 'bg-gray-100 text-gray-700']
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`} title={t.subestado ?? undefined}>
      {m && t.courierCode && !t.errorSeguimiento && <span aria-hidden="true">{m.icon}</span>}
      {texto}
    </span>
  )
}

function Renglon({ t, onEditar, onQuitar }: { t: NumeroGuardado; onEditar: () => void; onQuitar: () => void }) {
  const link = 'inline-flex min-h-6 items-center px-1 -mx-1 rounded hover:underline focus-visible:outline-2 focus-visible:outline-blue-600'
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-mono font-semibold text-gray-900 break-all">{t.numero}</span>
          <Chip t={t} />
        </p>
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-gray-600 min-w-0">
          <span className="break-words">
            {t.transportista ?? 'Sin courier'}
            {t.courierCode && t.consultado && <> · consultado {t.consultado}</>}
          </span>
          <button type="button" onClick={onEditar} className={`${link} text-blue-700`}>
            {t.errorSeguimiento ? 'Corregir' : 'Editar'}<span className="sr-only"> el número {t.numero}</span>
          </button>
          <button type="button" onClick={onQuitar} className={`${link} text-red-700`}>
            Quitar<span className="sr-only"> el número {t.numero}</span>
          </button>
        </p>
      </div>
      {t.courierCode && t.errorSeguimiento && (
        <p className="mt-1 text-xs text-red-700">{t.errorSeguimiento} Revisá el número o el courier con «Corregir».</p>
      )}
      {t.courierCode && !t.errorSeguimiento && t.ultimoEvento && (
        <p className="mt-1 text-xs text-gray-600 break-words">
          {t.ultimoEventoEn && <span className="font-mono">{fechaCourier(t.ultimoEventoEn)} · </span>}
          {t.ultimoEvento}
        </p>
      )}
      {t.eventos.length > 0 && (
        <details className="mt-1.5 group">
          <summary className="inline-flex min-h-6 items-center cursor-pointer text-xs font-medium text-blue-700 hover:underline">
            Ver {t.eventos.length === 1 ? 'el evento' : `los ${t.eventos.length} eventos`}
          </summary>
          <ol className="mt-2 ml-1.5 border-l-2 border-gray-200 space-y-3">
            {t.eventos.map((e, i) => (
              <li key={i} className="pl-4 relative">
                <span aria-hidden="true" className={`absolute -left-[7px] top-1 w-3 h-3 rounded-full ring-2 ring-gray-50 ${i === 0 ? 'bg-blue-600' : 'bg-gray-300'}`} />
                <p className={`text-sm break-words ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{e.detalle}</p>
                {(e.fecha || e.lugar) && (
                  <p className="text-xs text-gray-600">
                    {e.fecha && <span className="font-mono">{fechaCourier(e.fecha)}</span>}
                    {e.fecha && e.lugar && ' · '}
                    {e.lugar}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-gray-500">Fecha y hora del courier, como las reporta {t.courierCode === ONEWAY_CODE ? 'One Way Cargo' : 'Ship24'}.</p>
        </details>
      )}
    </>
  )
}

// El renglón que se escribe: número y courier visibles, el resto de la caja oculto alrededor
// para que la acción, que reemplaza todo, conserve los demás en el mismo orden.
function Edicion({ tramo, todos, reemplaza, inicial, couriers, guardar, placeholder, transportista, onCancelar }: {
  tramo: TramoTracking
  todos: NumeroGuardado[]
  reemplaza: number | null
  inicial: NumeroGuardado | null
  couriers: Courier[]
  guardar: (formData: FormData) => Promise<ActionResult>
  placeholder: string
  transportista: string
  onCancelar: () => void
}) {
  const i = reemplaza == null ? -1 : todos.findIndex(t => t.id === reemplaza)
  const antes = i === -1 ? todos : todos.slice(0, i)
  const despues = i === -1 ? [] : todos.slice(i + 1)
  const idNumero = `numero-${tramo}-${reemplaza ?? 'nuevo'}`
  const [numero, setNumero] = useState(inicial?.numero ?? '')
  const oneway = esCodigoOneway(tramo, numero)
  return (
    <FormConResultado action={guardar} className="flex flex-wrap items-end gap-3">
      <Ocultos filas={antes} />
      <div className="flex flex-col gap-1 min-w-0">
        <label htmlFor={idNumero} className="text-xs font-medium text-gray-700">Número</label>
        <input
          // Controlado: React 19 vacía los campos sueltos de un form después de enviarlo, y si la
          // acción lo rechaza el número tipeado se perdía.
          id={idNumero} type="text" name={`numero_${tramo}`} value={numero} onChange={e => setNumero(e.target.value)}
          placeholder={placeholder} required autoFocus autoComplete="off" spellCheck={false}
          className="w-56 max-w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <span aria-hidden="true" className="text-xs font-medium text-gray-700">Courier</span>
        {oneway ? (
          // La acción lo fija a One Way Cargo por el código: no hay nada que elegir.
          <div className="w-64 border border-green-300 bg-green-50 rounded-lg px-3 py-1.5 text-sm">
            <input type="hidden" name={`courier_${tramo}`} value="" />
            <input type="hidden" name={`libre_${tramo}`} value="" />
            <input type="hidden" name={`transportista_${tramo}`} value={ONEWAY_NOMBRE} />
            📡 {ONEWAY_NOMBRE}
          </div>
        ) : (
          <ElegirCourier
            tramo={tramo}
            inicial={{ code: inicial?.courierCode ?? null, nombre: inicial?.transportista ?? null }}
            couriers={couriers}
            placeholder={transportista}
          />
        )}
      </div>
      <Ocultos filas={despues} />
      <div className="flex gap-2">
        <PendingButton
          pendingLabel="Guardando…"
          className="min-h-9 px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-800 disabled:opacity-50"
        >
          Guardar
        </PendingButton>
        <button type="button" onClick={onCancelar} className="min-h-9 px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50">
          Cancelar
        </button>
      </div>
      <p className="basis-full text-xs text-gray-600">
        {oneway
          ? 'Código de One Way Cargo: se sigue solo cada hora con la cuenta.'
          : couriers.length > 0
          ? 'Elegido de la lista de Ship24, se sigue solo cada hora. Si no está (Zoom, Tealca), anotalo sin seguimiento.'
          : 'Ship24 está apagado: el courier queda anotado tal cual.'}
      </p>
    </FormConResultado>
  )
}

// Los mismos cuatro campos que manda ElegirCourier + el número, para un renglón guardado.
function Ocultos({ filas }: { filas: NumeroGuardado[] }) {
  return filas.map(f => (
    <Fragment key={f.id}>
      <input type="hidden" name={`numero_${f.tramo}`} value={f.numero} />
      <input type="hidden" name={`courier_${f.tramo}`} value={f.courierCode ?? ''} />
      <input type="hidden" name={`libre_${f.tramo}`} value={f.courierCode ? '' : '1'} />
      <input type="hidden" name={`transportista_${f.tramo}`} value={f.transportista ?? ''} />
    </Fragment>
  ))
}
