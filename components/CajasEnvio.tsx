'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import type { ActionResult } from '@/lib/action-result'
import {
  MAX_CAJAS_POR_ETAPA, cajasQueSeFacturan, resumenCajas, type CajaFisica, type ResumenCajas,
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

type Props = {
  action: (formData: FormData) => Promise<ActionResult>
  reempaque: boolean
  inicial: (CajaFisica & { etapa: string })[]
  /** Divisor volumétrico del aéreo (cm³ por kg), de Config. */
  divisor: number
}

// Las cajas físicas del envío como salen del depósito: es lo que se factura (cómo llegaron da
// igual, decisión del dueño). En la ficha ocupa una línea (lo guardado, resumido) y se edita en
// una ventana aparte. Se guardan como etapa 'llegada' sin reempaque (lib/cajas-envio.ts).
export default function CajasEnvio(props: Props) {
  const [abierto, setAbierto] = useState(false)
  const cerrar = useCallback(() => setAbierto(false), [])
  const { inicial, reempaque, divisor } = props
  const facturan = cajasQueSeFacturan(reempaque, inicial)
  const r = resumenCajas(facturan.cajas, divisor)
  const n = (k: number) => `${k} ${k === 1 ? 'caja' : 'cajas'}`
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-gray-700">
        {facturan.cajas.length === 0 ? (
          <span className="text-gray-500">Sin cajas cargadas: el costeo usa la suma de las piezas, que es un piso.</span>
        ) : (
          <>
            <span className="font-medium">{n(r.cajas)}</span>
            {r.pesoKg != null && <> · <span className="font-mono">{r.pesoKg.toFixed(2)} kg</span></>}
            {r.volumenM3 != null && <> · <span className="font-mono">{r.volumenM3.toFixed(3)} m³</span></>}
            {r.cobrableKg != null && <> · cobrable <span className="font-mono font-semibold">{r.cobrableKg.toFixed(2)} kg</span></>}
            {(r.sinPeso > 0 || r.sinMedidas > 0) && (
              <span className="block text-xs text-amber-700">
                {[r.sinPeso > 0 && `${r.sinPeso} sin pesar`, r.sinMedidas > 0 && `${r.sinMedidas} sin medir`].filter(Boolean).join(', ')}: ese total sale de la suma de las piezas.
              </span>
            )}
            {facturan.provisoria && (
              <span className="block text-xs text-amber-700">Son los pesos de antes de partir la caja: cargá las cajas que salen.</span>
            )}
          </>
        )}
      </div>
      <button
        type="button" onClick={() => setAbierto(true)}
        className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        {facturan.cajas.length === 0 ? 'Cargar cajas' : 'Editar cajas'}
      </button>
      {abierto && <VentanaCajas {...props} onCerrar={cerrar} />}
    </div>
  )
}

// La ventana, encima de la página (portal a body, como ConfirmarQuitar de los trackings). El
// editor se monta al abrirla, así «Cancelar» descarta lo tipeado. No se cierra tocando afuera:
// un clic perdido no tiene que tirar diez medidas cargadas a mano.
function VentanaCajas({ onCerrar, ...props }: Props & { onCerrar: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    window.addEventListener('keydown', onKey)
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previo
    }
  }, [onCerrar])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div role="dialog" aria-modal="true" aria-labelledby="cajas-titulo" className="w-full max-w-3xl bg-white rounded-xl shadow-xl p-5 my-8">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="cajas-titulo" className="text-sm font-semibold text-gray-800">📦 Cajas del envío</h2>
          <button type="button" onClick={onCerrar} title="Cerrar" className="px-2 text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Copiá del panel del transportista o del depósito el <em>Actual Weight</em> y las <em>Box Dimensions</em> de
          cada caja <strong>como sale del depósito</strong>. Reemplazan a la suma de las piezas: es lo que se
          factura, caja por caja.
        </p>
        <EditorCajas {...props} onGuardado={onCerrar} onCancelar={onCerrar} />
      </div>
    </div>,
    document.body,
  )
}

function EditorCajas({
  action,
  reempaque,
  inicial,
  divisor,
  onGuardado,
  onCancelar,
}: Props & { onGuardado: () => void; onCancelar: () => void }) {
  // Arranca con las que hoy se facturan (en una caja vieja reempacada, las de salida).
  const facturan = cajasQueSeFacturan(reempaque, inicial)
  const [siguiente, setSiguiente] = useState(inicial.length + 1)
  const [filas, setFilas] = useState<Fila[]>(() => {
    const guardadas = facturan.cajas
    // Una lista sin nada arranca con un renglón vacío, listo para escribir.
    return guardadas.length > 0
      ? guardadas.map((c, k) => ({
          key: k, referencia: c.referencia ?? '', peso: texto(c.pesoKg),
          largo: texto(c.largoCm), ancho: texto(c.anchoCm), alto: texto(c.altoCm),
        }))
      : [{ key: 0, referencia: '', peso: '', largo: '', ancho: '', alto: '' }]
  })

  function añadir() {
    setFilas(prev => [...prev, { key: siguiente, referencia: '', peso: '', largo: '', ancho: '', alto: '' }])
    setSiguiente(k => k + 1)
  }
  function quitar(key: number) {
    setFilas(prev => prev.filter(f => f.key !== key))
  }
  function cambiar(key: number, campo: Campo, valor: string) {
    setFilas(prev => prev.map(f => (f.key === key ? { ...f, [campo]: valor } : f)))
  }

  const r = resumenCajas(filas.filter(f => !vacia(f)).map(aCaja), divisor)
  const lleno = filas.length >= MAX_CAJAS_POR_ETAPA
  const etapa = 'llegada'

  return (
    <FormConResultado
      action={async fd => {
        const res = await action(fd)
        if (res.ok) onGuardado()
        return res
      }}
      className="space-y-4"
    >
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">
          Cajas que salen del depósito
          {r.cajas > 1 && <span className="ml-1 text-gray-400">({r.cajas})</span>}
        </p>
        {facturan.provisoria && (
          <p className="text-xs text-amber-700 mb-1">Son los pesos de antes de partir la caja: corregilos con las cajas que salen.</p>
        )}
        <div className="space-y-1.5">
          {filas.length > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-gray-400 uppercase tracking-wide">
              <span className="w-5" />
              <span className="w-44">Referencia</span>
              <span className="w-20">Peso kg</span>
              <span>L × A × H</span>
            </div>
          )}
          {filas.map((f, i) => {
            const c = aCaja(f)
            const volKg = c.largoCm && c.anchoCm && c.altoCm ? (c.largoCm * c.anchoCm * c.altoCm) / divisor : null
            return (
              <div key={f.key} className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-xs text-gray-400 text-right">{i + 1}</span>
                <input
                  type="text" name={`referencia_${etapa}`} value={f.referencia} placeholder="Referencia / ID del paquete"
                  onChange={e => cambiar(f.key, 'referencia', e.target.value)} aria-label="Referencia"
                  className="w-44 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="text" inputMode="decimal" name={`peso_${etapa}`} value={f.peso} placeholder="kg"
                  onChange={e => cambiar(f.key, 'peso', e.target.value)} aria-label="Peso (kg)"
                  className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <div className="flex items-center gap-1">
                  {(['largo', 'ancho', 'alto'] as const).map((d, j) => (
                    <div key={d} className="flex items-center gap-1">
                      {j > 0 && <span className="text-gray-300 text-sm">×</span>}
                      <input
                        type="text" inputMode="decimal" name={`${d}_${etapa}`} value={f[d]} placeholder={d === 'largo' ? 'L' : d === 'ancho' ? 'A' : 'H'}
                        onChange={e => cambiar(f.key, d, e.target.value)} aria-label={`${d} (cm)`}
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
                  type="button" onClick={() => quitar(f.key)} title="Quitar esta caja"
                  className="px-2 py-1 text-sm text-gray-400 hover:text-red-600 transition-colors"
                >
                  ✕
                </button>
              </div>
            )
          })}
          {filas.length === 0 && <p className="text-xs text-gray-400">Sin cajas.</p>}
        </div>
        <button
          type="button" onClick={añadir} disabled={lleno}
          className="mt-1.5 text-xs text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
        >
          {lleno ? `Máximo ${MAX_CAJAS_POR_ETAPA}` : '+ Añadir caja'}
        </button>
        <Totales r={r} />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <button
          type="button" onClick={onCancelar}
          className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Cancelar
        </button>
        <PendingButton className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors">
          Guardar cajas
        </PendingButton>
      </div>
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
