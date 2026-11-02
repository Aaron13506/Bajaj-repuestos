'use client'

import { useState } from 'react'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import type { ActionResult } from '@/lib/action-result'
import {
  ETAPA_CAJA_META, MAX_CAJAS_POR_ETAPA, cajasQueSeFacturan, resumenCajas,
  type CajaFisica, type EtapaCaja, type ResumenCajas,
} from '@/lib/cajas-envio'

type Fila = { key: number; referencia: string; peso: string; largo: string; ancho: string; alto: string }
type Campo = Exclude<keyof Fila, 'key'>

const texto = (n: number | null) => (n != null ? String(n) : '')
// Lo que se está tipeando, para los totales en vivo. Lo ilegible cuenta como vacío acá; al
// guardar, la acción lo rechaza con el motivo (leerCajasEtapa).
const leer = (s: string) => {
  const v = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(v) && v > 0 ? v : null
}
const aCaja = (f: Fila): CajaFisica => ({
  referencia: f.referencia.trim() || null,
  pesoKg: leer(f.peso),
  largoCm: leer(f.largo),
  anchoCm: leer(f.ancho),
  altoCm: leer(f.alto),
})
const vacia = (f: Fila) => !f.referencia.trim() && !f.peso.trim() && !f.largo.trim() && !f.ancho.trim() && !f.alto.trim()

// Las cajas físicas del envío: lo que llegó al depósito y, si hubo reempaque, lo que sale. El
// form manda todo junto y la acción reemplaza lo guardado (guardarCajas). La página lo monta
// con una `key` que cambia con lo guardado, así después de guardar arranca de nuevo.
export default function CajasEnvio({
  action,
  reempaque: reempaqueInicial,
  inicial,
  divisor,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  reempaque: boolean
  inicial: (CajaFisica & { etapa: string })[]
  /** Divisor volumétrico del aéreo (cm³ por kg), de Config. */
  divisor: number
}) {
  const [reempaque, setReempaque] = useState(reempaqueInicial)
  const [siguiente, setSiguiente] = useState(inicial.length + 2)
  const [filas, setFilas] = useState<Record<EtapaCaja, Fila[]>>(() => {
    let k = 0
    const de = (etapa: EtapaCaja) => {
      const guardadas = inicial.filter(c => c.etapa === etapa)
      // Una lista sin nada arranca con un renglón vacío, listo para escribir.
      return guardadas.length > 0
        ? guardadas.map(c => ({
            key: k++, referencia: c.referencia ?? '', peso: texto(c.pesoKg),
            largo: texto(c.largoCm), ancho: texto(c.anchoCm), alto: texto(c.altoCm),
          }))
        : [{ key: k++, referencia: '', peso: '', largo: '', ancho: '', alto: '' }]
    }
    return { llegada: de('llegada'), salida: de('salida') }
  })

  function añadir(etapa: EtapaCaja) {
    setFilas(prev => ({ ...prev, [etapa]: [...prev[etapa], { key: siguiente, referencia: '', peso: '', largo: '', ancho: '', alto: '' }] }))
    setSiguiente(k => k + 1)
  }
  function quitar(etapa: EtapaCaja, key: number) {
    setFilas(prev => ({ ...prev, [etapa]: prev[etapa].filter(f => f.key !== key) }))
  }
  function cambiar(etapa: EtapaCaja, key: number, campo: Campo, valor: string) {
    setFilas(prev => ({ ...prev, [etapa]: prev[etapa].map(f => (f.key === key ? { ...f, [campo]: valor } : f)) }))
  }

  const cajas = (etapa: EtapaCaja) => filas[etapa].filter(f => !vacia(f)).map(aCaja)
  const llegada = cajas('llegada')
  const salida = cajas('salida')
  const resumen = { llegada: resumenCajas(llegada, divisor), salida: resumenCajas(salida, divisor) }
  const facturan = cajasQueSeFacturan(reempaque, [
    ...llegada.map(c => ({ ...c, etapa: 'llegada' })),
    ...salida.map(c => ({ ...c, etapa: 'salida' })),
  ])
  const salidaSePierde = !reempaque && salida.length > 0

  const lista = (etapa: EtapaCaja) => {
    const r = resumen[etapa]
    const seFactura = facturan.etapa === etapa && r.cajas > 0
    const lleno = filas[etapa].length >= MAX_CAJAS_POR_ETAPA
    return (
      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs font-medium text-gray-600">
            {reempaque ? ETAPA_CAJA_META[etapa].label : 'Cajas'}
            {r.cajas > 1 && <span className="ml-1 text-gray-400">({r.cajas})</span>}
          </p>
          {seFactura && (
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${facturan.provisoria ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}
              title={facturan.provisoria ? 'Todavía no cargaste las cajas que salen: se costea con lo que llegó.' : 'Con estas cajas se costea el envío.'}
            >
              {facturan.provisoria ? 'SE COSTEA (PROVISORIO)' : 'SE COSTEA'}
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          {filas[etapa].length > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-gray-400 uppercase tracking-wide">
              <span className="w-5" />
              <span className="w-44">Referencia</span>
              <span className="w-20">Peso kg</span>
              <span>L × A × H</span>
            </div>
          )}
          {filas[etapa].map((f, i) => {
            const c = aCaja(f)
            const volKg = c.largoCm && c.anchoCm && c.altoCm ? (c.largoCm * c.anchoCm * c.altoCm) / divisor : null
            return (
              <div key={f.key} className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-xs text-gray-400 text-right">{i + 1}</span>
                <input
                  type="text" name={`referencia_${etapa}`} value={f.referencia} placeholder="Referencia / ID del paquete"
                  onChange={e => cambiar(etapa, f.key, 'referencia', e.target.value)} aria-label="Referencia"
                  className="w-44 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="text" inputMode="decimal" name={`peso_${etapa}`} value={f.peso} placeholder="kg"
                  onChange={e => cambiar(etapa, f.key, 'peso', e.target.value)} aria-label="Peso (kg)"
                  className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <div className="flex items-center gap-1">
                  {(['largo', 'ancho', 'alto'] as const).map((d, j) => (
                    <div key={d} className="flex items-center gap-1">
                      {j > 0 && <span className="text-gray-300 text-sm">×</span>}
                      <input
                        type="text" inputMode="decimal" name={`${d}_${etapa}`} value={f[d]} placeholder={d === 'largo' ? 'L' : d === 'ancho' ? 'A' : 'H'}
                        onChange={e => cambiar(etapa, f.key, d, e.target.value)} aria-label={`${d} (cm)`}
                        className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  ))}
                  <span className="text-xs text-gray-400 ml-1">cm</span>
                </div>
                <span className="text-xs text-gray-400 font-mono w-24" title="Peso volumétrico de esta caja">
                  {volKg != null ? `vol ${volKg.toFixed(2)} kg` : ''}
                </span>
                <button
                  type="button" onClick={() => quitar(etapa, f.key)} title="Quitar esta caja"
                  className="px-2 py-1 text-sm text-gray-400 hover:text-red-600 transition-colors"
                >
                  ✕
                </button>
              </div>
            )
          })}
          {filas[etapa].length === 0 && <p className="text-xs text-gray-400">Sin cajas.</p>}
        </div>
        <button
          type="button" onClick={() => añadir(etapa)} disabled={lleno}
          className="mt-1.5 text-xs text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
        >
          {lleno ? `Máximo ${MAX_CAJAS_POR_ETAPA}` : '+ Añadir caja'}
        </button>
        <Totales r={r} />
      </div>
    )
  }

  return (
    <FormConResultado action={action} className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox" name="reempaque" value="1" checked={reempaque}
          onChange={e => setReempaque(e.target.checked)}
          className="rounded border-gray-300"
        />
        Hubo reempaque en el depósito
        <span className="text-xs text-gray-400">(juntaron o rearmaron las cajas antes de despacharlas)</span>
      </label>

      {lista('llegada')}
      {reempaque && (
        <>
          {lista('salida')}
          <CambioReempaque antes={resumen.llegada} despues={resumen.salida} />
        </>
      )}
      {salidaSePierde && (
        <p className="text-xs text-amber-700">
          Al guardar sin reempaque se borran {salida.length === 1 ? 'la caja' : `las ${salida.length} cajas`} de salida.
        </p>
      )}

      <PendingButton className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
        Guardar cajas
      </PendingButton>
    </FormConResultado>
  )
}

function Totales({ r }: { r: ResumenCajas }) {
  if (r.cajas === 0) return null
  const faltan = [
    r.sinPeso > 0 && `${r.sinPeso === r.cajas ? 'todas' : r.sinPeso} sin pesar`,
    r.sinMedidas > 0 && `${r.sinMedidas === r.cajas ? 'todas' : r.sinMedidas} sin medir`,
  ].filter(Boolean)
  return (
    <p className="mt-1.5 text-xs text-gray-500">
      {r.cajas} {r.cajas === 1 ? 'caja' : 'cajas'}
      {r.pesoKg != null && <> · <span className="font-mono">{r.pesoKg.toFixed(2)} kg</span> reales</>}
      {r.volumetricoKg != null && <> · <span className="font-mono">{r.volumetricoKg.toFixed(2)} kg</span> volumétricos ({r.volumenM3!.toFixed(3)} m³)</>}
      {r.cobrableKg != null && <> · cobrable caja por caja <span className="font-mono font-semibold text-gray-700">{r.cobrableKg.toFixed(2)} kg</span></>}
      {faltan.length > 0 && <span className="text-amber-700"> · {faltan.join(', ')}: ese total no se cuenta</span>}
    </p>
  )
}

// Qué cambió con el reempaque: el depósito suele achicar el volumen (y sumar algo de cartón).
function CambioReempaque({ antes, despues }: { antes: ResumenCajas; despues: ResumenCajas }) {
  if (antes.cajas === 0 || despues.cajas === 0) return null
  const dif = (a: number | null, b: number | null, u: string, dec: number) =>
    a != null && b != null ? `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(dec)} ${u}` : null
  const partes = [
    `${antes.cajas} → ${despues.cajas} ${despues.cajas === 1 ? 'caja' : 'cajas'}`,
    dif(antes.pesoKg, despues.pesoKg, 'kg reales', 2),
    dif(antes.volumenM3, despues.volumenM3, 'm³', 3),
    dif(antes.cobrableKg, despues.cobrableKg, 'kg cobrables', 2),
  ].filter(Boolean)
  return <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">Reempaque: {partes.join(' · ')}</p>
}
