'use client'

import { useId, useMemo, useState } from 'react'
import { buscarCouriers, type CourierTM } from '@/lib/trackingmore'

export type CourierInicial = { code: string | null; nombre: string | null }

// El courier de un renglón de tracking: un buscador sobre la lista de TrackingMore, no un texto
// libre. Lo elegido viaja como code (`courier_<tramo>`), así que no hay tipeo que falle. Para
// lo que TrackingMore no rastrea (Zoom, Tealca, una referencia de Shoppre) está «anotar sin
// seguimiento», que hay que elegir a propósito. Texto escrito sin elegir nada lo rechaza la
// acción (courierDeFila). Sin lista (TrackingMore apagado) es un texto libre como antes.
//
// Manda tres campos paralelos a `numero_<tramo>`: courier_, libre_ y transportista_.
export default function ElegirCourier({
  tramo,
  inicial,
  couriers,
  placeholder,
}: {
  tramo: string
  inicial: CourierInicial
  couriers: CourierTM[]
  placeholder: string
}) {
  const hayLista = couriers.length > 0
  const idLista = useId()
  const porCode = useMemo(() => new Map(couriers.map(c => [c.code, c])), [couriers])
  const [code, setCode] = useState<string | null>(inicial.code && porCode.has(inicial.code) ? inicial.code : null)
  // Lo ya guardado sin courier era texto escrito a mano: se respeta como «sin seguimiento».
  const [libre, setLibre] = useState(!inicial.code && !!inicial.nombre)
  const [texto, setTexto] = useState(inicial.code ? '' : (inicial.nombre ?? ''))
  const [abierto, setAbierto] = useState(false)
  const [activo, setActivo] = useState(0)

  const elegido = code ? porCode.get(code) ?? null : null
  const opciones = useMemo(() => (abierto && !libre ? buscarCouriers(texto, couriers) : []), [abierto, libre, texto, couriers])

  const campos = (
    <>
      <input type="hidden" name={`courier_${tramo}`} value={elegido?.code ?? ''} />
      <input type="hidden" name={`libre_${tramo}`} value={!elegido && (libre || !hayLista) ? '1' : ''} />
      <input type="hidden" name={`transportista_${tramo}`} value={elegido ? elegido.nombre : texto} />
    </>
  )

  function elegir(c: CourierTM) {
    setCode(c.code)
    setLibre(false)
    setTexto('')
    setAbierto(false)
  }

  if (elegido) {
    return (
      <div className="w-64 flex items-center gap-2 border border-green-300 bg-green-50 rounded-lg px-3 py-1.5 text-sm">
        {campos}
        <span className="truncate" title={`${elegido.nombre} · ${elegido.code}`}>
          📡 {elegido.nombre}
          {elegido.pais && <span className="ml-1 text-xs text-gray-400">{elegido.pais}</span>}
        </span>
        <button
          type="button" onClick={() => { setCode(null); setAbierto(true) }}
          className="ml-auto text-xs text-blue-600 hover:underline shrink-0"
        >
          cambiar
        </button>
      </div>
    )
  }

  if (!hayLista || libre) {
    return (
      <div className="w-64 flex items-center gap-2">
        {campos}
        <input
          type="text" value={texto} placeholder={placeholder} autoComplete="off"
          onChange={e => setTexto(e.target.value)}
          aria-label={`Transportista ${tramo}`}
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {hayLista && (
          <button
            type="button" onClick={() => { setLibre(false); setAbierto(true) }}
            title="Sin seguimiento automático. Tocá para buscarlo en la lista de TrackingMore."
            className="text-[10px] whitespace-nowrap px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
          >
            sin seguimiento ↺
          </button>
        )}
      </div>
    )
  }

  const sinElegir = texto.trim() !== ''
  return (
    <div className="relative w-64">
      {campos}
      <input
        type="text" value={texto} placeholder="Buscar courier… (Delhivery, DTDC, DHL)" autoComplete="off"
        role="combobox" aria-expanded={opciones.length > 0} aria-controls={idLista} aria-label={`Courier ${tramo}`}
        onChange={e => { setTexto(e.target.value); setAbierto(true); setActivo(0) }}
        onFocus={() => setAbierto(true)}
        onBlur={() => setAbierto(false)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActivo(i => Math.min(i + 1, opciones.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActivo(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && opciones.length > 0) { e.preventDefault(); elegir(opciones[activo] ?? opciones[0]) }
          else if (e.key === 'Escape') setAbierto(false)
        }}
        className={`w-full border rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
          sinElegir ? 'border-amber-400' : 'border-gray-300'
        }`}
      />
      {abierto && texto.trim() !== '' && (
        // onMouseDown + preventDefault: elegir antes de que el blur cierre la lista.
        <ul id={idLista} className="absolute z-20 mt-1 w-80 max-h-72 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
          {opciones.map((c, i) => (
            <li key={c.code}>
              <button
                type="button" onMouseDown={e => { e.preventDefault(); elegir(c) }} onMouseEnter={() => setActivo(i)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${i === activo ? 'bg-blue-50' : ''}`}
              >
                <span className="truncate">{c.nombre}</span>
                <span className="ml-auto text-[10px] text-gray-400 font-mono shrink-0">{c.code}{c.pais ? ` · ${c.pais}` : ''}</span>
              </button>
            </li>
          ))}
          {opciones.length === 0 && <li className="px-3 py-1.5 text-xs text-gray-400">Ningún courier con ese nombre.</li>}
          <li className="border-t border-gray-100">
            <button
              type="button" onMouseDown={e => { e.preventDefault(); setLibre(true); setAbierto(false) }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              Anotar «{texto.trim()}» sin seguimiento
            </button>
          </li>
        </ul>
      )}
      {sinElegir && !abierto && (
        <p className="mt-0.5 text-[10px] text-amber-700">Elegí uno de la lista (o «anotar sin seguimiento»).</p>
      )}
    </div>
  )
}
