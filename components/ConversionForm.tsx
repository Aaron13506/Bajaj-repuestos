'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { convertir } from '@/lib/conversion'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  /** Lo que vale hoy un bolívar del banco según el libro (USD por Bs). null = el libro no tiene Bs anotados. */
  valor: number | null
}

const usd = (n: number) => `$${n.toFixed(2)}`
const nf = (n: number, d = 2) => n.toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d })

// Pasar plata a USDT: Bs del banco o efectivo en dólares. Se escribe lo que se dio y lo que se
// recibió (P2P o en persona: a veces quitan, a veces dan a favor). De ahí sale lo que costó contra
// lo que el libro decía que valía lo entregado. Se anota como una salida de la cuenta de origen y
// una entrada a Binance, juntas.
export default function ConversionForm({ action, valor }: Props) {
  const [desde, setDesde] = useState<'banco_bs' | 'efectivo_usd'>('banco_bs')
  const [dado, setDado] = useState('')
  const [usdt, setUsdt] = useState('')
  const { enviar, isPending, error } = useEnviarAccion(action, () => { setDado(''); setUsdt('') })

  const enBs = desde === 'banco_bs'
  const b = parseFloat(dado)
  const u = parseFloat(usdt)
  const c = b > 0 && u > 0 ? convertir(b, u, enBs ? (valor ?? u / b) : 1) : null

  return (
    <form
      onSubmit={enviar}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8"
    >
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Pasar a USDT</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Desde</label>
          <select
            name="desde" value={desde} onChange={e => setDesde(e.target.value as typeof desde)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="banco_bs">Banco (Bs)</option>
            <option value="efectivo_usd">Efectivo USD</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">{enBs ? 'Bs que di' : '$ en efectivo que di'}</label>
          <input
            type="number" name="dado" min={0.01} step="0.01" required value={dado} onChange={e => setDado(e.target.value)}
            className="w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">USDT que recibí</label>
          <input
            type="number" name="usdt" min={0.01} step="0.01" required value={usdt} onChange={e => setUsdt(e.target.value)}
            className="w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Fecha</label>
          <CampoFecha
            name="fecha"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-sm font-medium text-gray-800 mb-1">Nota (opcional)</label>
          <input
            type="text" name="descripcion"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          type="submit" disabled={isPending}
          className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {isPending ? 'Guardando…' : 'Registrar conversión'}
        </button>
      </div>

      {c ? (
        <p className="text-xs text-gray-500 mt-3">
          {enBs && <>A <span className="font-mono">{nf(c.tasaEfectiva)} Bs por USDT</span>. En el libro esos Bs valían{' '}</>}
          {!enBs && 'Diste '}
          <span className="font-mono">{usd(c.valorLibroUsd)}</span>
          {enBs && valor == null && ' (el libro no tiene Bs anotados para compararlos: se toman por lo que recibiste)'}
          {' → '}
          {Math.abs(c.costoUsd) < 0.005
            ? 'sin costo.'
            : c.costoUsd > 0
              ? <span className="text-red-600">costó {usd(c.costoUsd)} ({nf(c.costoPct, 1)}%).</span>
              : <span className="text-green-700">ganaste {usd(-c.costoUsd)} ({nf(-c.costoPct, 1)}%).</span>}
        </p>
      ) : (
        <p className="text-xs text-gray-400 mt-3">
          Escribí lo que diste y lo que recibiste, y ves cuánto costó (o cuánto salió a favor).
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
    </form>
  )
}
