'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { convertir } from '@/lib/conversion'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  /** Lo que vale hoy un bolívar del banco según el libro (USD por Bs), y de dónde sale. */
  valor: { usdPorBs: number; fuente: 'libro' | 'config' } | null
}

const usd = (n: number) => `$${n.toFixed(2)}`
const nf = (n: number, d = 2) => n.toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d })

// Pasar Bs a USDT: cuántos bolívares se dieron y cuántos USDT se recibieron. De ahí salen la
// tasa a la que se hizo y lo que costó convertir (contra lo que el libro decía que valían esos
// Bs). Se anota como una salida del banco en Bs y una entrada a Binance, juntas.
export default function ConversionForm({ action, valor }: Props) {
  const [bs, setBs] = useState('')
  const [usdt, setUsdt] = useState('')
  const { enviar, isPending, error } = useEnviarAccion(action, () => { setBs(''); setUsdt('') })

  const b = parseFloat(bs)
  const u = parseFloat(usdt)
  const c = valor && b > 0 && u > 0 ? convertir(b, u, valor.usdPorBs) : null

  return (
    <form
      onSubmit={enviar}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8"
    >
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Pasar Bs a USDT</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Bs que di</label>
          <input
            type="number" name="bs" min={0.01} step="0.01" required value={bs} onChange={e => setBs(e.target.value)}
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
          A <span className="font-mono">{nf(c.tasaEfectiva)} Bs por USDT</span>. En el libro esos Bs valían{' '}
          <span className="font-mono">{usd(c.valorLibroUsd)}</span>
          {valor?.fuente === 'config' && ' (estimado con la tasa de /config: todavía no hay cobros en Bs con sus Bs anotados)'}
          {' → '}
          {Math.abs(c.costoUsd) < 0.005
            ? 'sin costo.'
            : c.costoUsd > 0
              ? <span className="text-red-600">costó {usd(c.costoUsd)} ({nf(c.costoPct, 1)}%).</span>
              : <span className="text-green-700">ganaste {usd(-c.costoUsd)} ({nf(-c.costoPct, 1)}%).</span>}
        </p>
      ) : (
        <p className="text-xs text-gray-400 mt-3">
          {valor
            ? 'Escribí los dos montos y ves cuánto costó convertir contra lo que el libro decía que valían esos Bs.'
            : 'No hay tasa para valorar los Bs: cargala en /config o registrá primero un cobro en Bs.'}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
    </form>
  )
}
