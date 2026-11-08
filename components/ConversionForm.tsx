'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'
import { convertir } from '@/lib/conversion'
import { CUENTAS, CUENTA_LABELS, type Cuenta } from '@/lib/cuentas'

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  /** Lo que vale hoy un bolívar del banco según el libro (USD por Bs). null = el libro no tiene Bs anotados. */
  valor: number | null
}

const usd = (n: number) => `$${n.toFixed(2)}`
const nf = (n: number, d = 2) => n.toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d })

// Pasar plata de una cuenta a otra (Bs, efectivo, USDT, banco en dólares). Se escribe lo que se
// dio y lo que se recibió (P2P o en persona: a veces quitan, a veces dan a favor). De ahí sale lo
// que costó contra lo que el libro decía que valía lo entregado. Se anota como una salida de la
// cuenta de origen y una entrada a la de destino, juntas.
export default function ConversionForm({ action, valor }: Props) {
  const [desde, setDesde] = useState<Cuenta>('banco_bs')
  const [hacia, setHacia] = useState<Cuenta>('usdt')
  const [dado, setDado] = useState('')
  const [recibido, setRecibido] = useState('')
  const { enviar, isPending, error } = useEnviarAccion(action, () => { setDado(''); setRecibido('') })

  const daBs = desde === 'banco_bs'
  const recibeBs = hacia === 'banco_bs'
  const unidad = (c: Cuenta) => c === 'banco_bs' ? 'Bs' : c === 'usdt' ? 'USDT' : '$'
  // El origen ofrece las 4; el destino, las otras 3. Si el origen pisa al destino, este pasa a la primera libre.
  const elegirDesde = (v: Cuenta) => { setDesde(v); if (v === hacia) setHacia(CUENTAS.find(k => k !== v)!) }
  const b = parseFloat(dado)
  const u = parseFloat(recibido)
  const c = b > 0 && u > 0 ? convertir(b, u, daBs ? (valor ?? u / b) : 1, recibeBs) : null

  const CAMPO = 'h-10 w-full border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
  const ETIQUETA = 'flex flex-col gap-1 text-xs font-medium text-gray-600 min-w-0'

  return (
    <form onSubmit={enviar} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      <label className={ETIQUETA}>
        De dónde sale
        <select name="desde" value={desde} onChange={e => elegirDesde(e.target.value as Cuenta)} className={CAMPO}>
          {CUENTAS.map(k => <option key={k} value={k}>{CUENTA_LABELS[k]}</option>)}
        </select>
      </label>
      <label className={ETIQUETA}>
        A dónde va
        <select name="hacia" value={hacia} onChange={e => setHacia(e.target.value as Cuenta)} className={CAMPO}>
          {CUENTAS.filter(k => k !== desde).map(k => <option key={k} value={k}>{CUENTA_LABELS[k]}</option>)}
        </select>
      </label>
      <label className={ETIQUETA}>
        {unidad(desde)} que di
        <input
          type="number" name="dado" min={0.01} step="0.01" inputMode="decimal" required value={dado} onChange={e => setDado(e.target.value)}
          className={`${CAMPO} tabular-nums`}
        />
      </label>
      <label className={ETIQUETA}>
        {unidad(hacia)} que recibí
        <input
          type="number" name="recibido" min={0.01} step="0.01" inputMode="decimal" required value={recibido} onChange={e => setRecibido(e.target.value)}
          className={`${CAMPO} tabular-nums`}
        />
      </label>
      <label className={ETIQUETA}>
        Fecha
        <CampoFecha name="fecha" className={CAMPO} />
      </label>

      {/* Región fija: el resultado se anuncia al cambiar, sin montarse de nuevo. */}
      <p aria-live="polite" className="sm:col-span-2 text-sm text-gray-600 text-pretty">
        {c ? (
          <>
            {daBs && <>A <span className="tabular-nums">{nf(c.tasaEfectiva)} Bs por {unidad(hacia)}</span>. En el libro esos Bs valían{' '}</>}
            {recibeBs && <>A <span className="tabular-nums">{nf(1 / c.tasaEfectiva)} Bs por {unidad(desde)}</span>. Diste{' '}</>}
            {!daBs && !recibeBs && 'Diste '}
            <span className="tabular-nums">{usd(c.valorLibroUsd)}</span>
            {daBs && valor == null && ' (el libro no tiene Bs anotados para compararlos: se toman por lo que recibiste)'}
            {recibeBs
              ? ': los Bs entran al libro por eso (lo que cuesten se ve cuando se usen).'
              : <>
                  {' → '}
                  {Math.abs(c.costoUsd) < 0.005
                    ? 'sin costo.'
                    : c.costoUsd > 0
                      ? <span className="font-medium text-red-700">costó {usd(c.costoUsd)} ({nf(c.costoPct, 1)}%).</span>
                      : <span className="font-medium text-green-700">ganaste {usd(-c.costoUsd)} ({nf(-c.costoPct, 1)}%).</span>}
                </>}
          </>
        ) : 'Escribí lo que diste y lo que recibiste, y ves cuánto costó (o cuánto salió a favor).'}
      </p>

      <label className={`${ETIQUETA} sm:col-span-2`}>
        Nota (opcional)
        <input type="text" name="descripcion" className={CAMPO} />
      </label>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit" disabled={isPending}
          className="inline-flex items-center min-h-10 bg-blue-600 text-white px-5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-wait transition-colors"
        >
          {isPending ? 'Guardando…' : 'Anotar conversión'}
        </button>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
    </form>
  )
}
