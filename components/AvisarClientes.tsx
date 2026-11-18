'use client'

import { useState } from 'react'
import { mensajeEstado, VERSIONES_VENEZUELA, type MensajeInput } from '@/lib/mensajes-cliente'
import { BOTON } from '@/components/clases-boton'
import { enlaceWhatsApp } from '@/lib/utils'

export interface AvisoCliente {
  tel: string | null
  input: MensajeInput
}

type Version = (typeof VERSIONES_VENEZUELA)[number]['value']

// Cola de avisos de la caja: un clic abre el WhatsApp del siguiente cliente con su mensaje
// escrito, y el dueño lo manda. Uno por clic porque el navegador bloquea varias pestañas de
// un solo clic. Lo avisado vive solo en esta pestaña: no se guarda.
export default function AvisarClientes({ avisos }: { avisos: AvisoCliente[] }) {
  const [version, setVersion] = useState<Version>('transito')
  const [avisados, setAvisados] = useState<Set<number>>(new Set())
  const hayVenezuela = avisos.some(a => a.input.etapa === 'camino_venezuela')
  const url = (a: AvisoCliente) =>
    enlaceWhatsApp(a.tel, mensajeEstado({ ...a.input, version }))
  // Abre el chat ANTES de marcar: si el navegador siguiera el href después del re-render,
  // ya apuntaría al cliente siguiente (abría el de después y salteaba a este).
  const abrir = (e: React.MouseEvent, a: AvisoCliente) => {
    e.preventDefault()
    window.open(url(a), '_blank', 'noopener,noreferrer')
    setAvisados(s => new Set(s).add(a.input.pedidoId))
  }
  const siguiente = avisos.find(a => !avisados.has(a.input.pedidoId))

  return (
    <details className="group bg-white rounded-xl shadow-sm border border-gray-100 mb-4">
      <summary className="list-none [&::-webkit-details-marker]:hidden flex items-start justify-between gap-3 px-4 sm:px-6 py-3 cursor-pointer">
        <span className="min-w-0">
          <span className="block text-base font-semibold text-gray-900">Avisar a los clientes</span>
          <span className="block text-sm text-gray-600">
            {avisados.size > 0 ? `${avisados.size} de ${avisos.length} avisados` : `${avisos.length} ${avisos.length === 1 ? 'pedido' : 'pedidos'} por WhatsApp, uno por clic`}
          </span>
        </span>
        <span aria-hidden="true" className="mt-1 text-gray-500 transition-transform group-open:rotate-90">▶</span>
      </summary>
      <div className="border-t border-gray-100 px-4 sm:px-6 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {hayVenezuela && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              Camino a Venezuela:
              <select
                value={version}
                onChange={e => setVersion(e.target.value as Version)}
                className="min-h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm"
              >
                {VERSIONES_VENEZUELA.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </label>
          )}
          {siguiente ? (
            <a
              href={url(siguiente)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => abrir(e, siguiente)}
              className={BOTON.whatsapp}
            >
              Abrir siguiente: {siguiente.input.nombre} · {avisados.size + 1} de {avisos.length}
            </a>
          ) : (
            <p className="text-sm font-medium text-green-700">Todos avisados.</p>
          )}
          {avisados.size > 0 && (
            <button type="button" onClick={() => setAvisados(new Set())} className="text-sm text-gray-600 underline hover:text-gray-900">
              Empezar de nuevo
            </button>
          )}
        </div>
        <ul className="divide-y divide-gray-100 text-sm">
          {avisos.map(a => {
            const hecho = avisados.has(a.input.pedidoId)
            return (
              <li key={a.input.pedidoId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={hecho ? 'text-gray-500' : 'text-gray-900'}>
                  {hecho && <span aria-hidden="true">✓ </span>}#{a.input.pedidoId} {a.input.nombre}
                  {!a.tel && <span className="ml-2 text-xs text-amber-700">sin teléfono: WhatsApp te deja elegir el contacto</span>}
                  {hecho && <span className="sr-only"> (avisado)</span>}
                </span>
                <a href={url(a)} target="_blank" rel="noopener noreferrer" onClick={e => abrir(e, a)} className="text-green-700 hover:underline">
                  {hecho ? 'Abrir de nuevo' : 'Abrir'}<span className="sr-only"> el WhatsApp de {a.input.nombre} (otra pestaña)</span>
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}
