'use client'

import { useEffect, useState } from 'react'
import { limpiarNombre } from '@/lib/utils'
import type { PiezaAContar } from '@/lib/conteo'
import type { ActionResult } from '@/lib/action-result'
import { useAccionDirecta } from './useEnviarAccion'
import FormConResultado from './FormConResultado'
import PendingButton from './PendingButton'
import { medirPieza } from '@/app/(pages)/products/actions'

// El código de la etiqueta puede venir con espacios o guiones que el catálogo no tiene.
const normalizar = (s: string) => s.toLowerCase().replace(/[\s-]/g, '')

// Paso intermedio entre "llegó la caja" y "recibida": se cuenta pieza por pieza contra lo
// esperado y recién ahí se recibe. El conteo no se guarda en la base (solo verifica); el
// borrador vive en este navegador para no perderlo si se recarga a mitad de la caja.
export default function ConteoCaja({
  envioId,
  piezas,
  recibir,
  aviso,
  yaRecibida = false,
}: {
  envioId: number
  piezas: PiezaAContar[]
  recibir: () => Promise<ActionResult>
  // Qué hace "Marcar recibido" en esta caja (suma stock, mueve etapas…).
  aviso: string
  // Ya está recibida (o en Venezuela): contar sigue sirviendo, y el botón solo cierra el conteo.
  yaRecibida?: boolean
}) {
  const clave = `conteo-caja-${envioId}`
  const [conteo, setConteo] = useState<Record<string, string>>({})
  const [busca, setBusca] = useState('')
  const [ultimo, setUltimo] = useState<{ texto: string; malo: boolean } | null>(null)
  // Pieza que se ofrece pesar. Al guardar, la página vuelve sin `estimada` y el form se va solo.
  const [aMedir, setAMedir] = useState<string | null>(null)
  // Contar es opcional: lo abre el botón de arriba a la derecha (un enlace a #conteo, ver BotonConteo).
  const [abierto, setAbierto] = useState(false)
  // Confirmar en la misma tarjeta, con lo que no coincide a la vista (antes era un confirm() del navegador).
  const [confirmando, setConfirmando] = useState(false)
  useEffect(() => {
    const sync = () => setAbierto(location.hash === '#conteo')
    sync()
    addEventListener('hashchange', sync)
    return () => removeEventListener('hashchange', sync)
  }, [])
  function cerrar() {
    history.replaceState(null, '', location.pathname + location.search)
    setAbierto(false)
  }
  const { pending, error, ejecutar } = useAccionDirecta()

  // Se lee después de montar: el server no ve localStorage y leerlo en el render desfasa la hidratación.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setConteo(JSON.parse(localStorage.getItem(clave) ?? '{}')) } catch {}
  }, [clave])

  function anotar(c: string, v: string) {
    const nuevo = { ...conteo, [c]: v }
    setConteo(nuevo)
    try { localStorage.setItem(clave, JSON.stringify(nuevo)) } catch {}
  }

  // Vacío = todavía no la contaste; 0 = la buscaste y no está.
  const llego = (p: PiezaAContar) => {
    const v = conteo[p.clave]
    return v == null || v === '' ? null : Number(v)
  }
  // Pieza en la mano: se tipea su código (o parte del nombre) y Enter suma 1. Un código exacto
  // gana aunque haya otros que lo contengan; si no, solo suma cuando queda una sola fila.
  const q = normalizar(busca)
  const visibles = q ? piezas.filter(p => normalizar(p.codigo ?? '').includes(q) || normalizar(p.nombre).includes(q)) : piezas
  function sumarUna() {
    if (!q) return
    const exacta = piezas.find(p => p.codigo != null && normalizar(p.codigo) === q)
    const p = exacta ?? (visibles.length === 1 ? visibles[0] : null)
    if (!p) {
      setUltimo({ texto: visibles.length === 0 ? `«${busca}» no viene en esta caja` : `${visibles.length} piezas coinciden: elegí abajo`, malo: true })
      return
    }
    const n = (llego(p) ?? 0) + 1
    anotar(p.clave, String(n))
    setUltimo({ texto: `+1 ${limpiarNombre(p.nombre)} → ${n}/${p.esperado}`, malo: n > p.esperado })
    setBusca('')
    setAMedir(p.estimada ? p.clave : null)
  }
  const medible = piezas.find(p => p.clave === aMedir && p.estimada)

  const contadas = piezas.filter(p => llego(p) != null).length
  const conDiferencia = piezas.filter(p => llego(p) != null && llego(p) !== p.esperado).length
  const completo = contadas === piezas.length

  const textoBoton = yaRecibida ? 'Terminar conteo' : 'Marcar recibido'
  const difs = piezas.filter(p => llego(p) != null && llego(p) !== p.esperado)
  function marcarRecibido() {
    ejecutar(async () => {
      const r = await recibir()
      if (r.ok) {
        try { localStorage.removeItem(clave) } catch {}
        setConteo({})
        setConfirmando(false)
        cerrar()
      }
      return r
    })
  }

  if (!abierto) return null

  return (
    <section id="conteo" aria-labelledby="conteo-titulo" className="scroll-mt-4 bg-white rounded-xl shadow-sm border border-gray-100 mb-4">
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="conteo-titulo" className="text-base font-semibold text-gray-900">Contar y validar</h2>
          <p className="text-sm text-gray-600">
            {contadas} de {piezas.length} {piezas.length === 1 ? 'código contado' : 'códigos contados'}
            {conDiferencia > 0 && <span className="font-semibold text-red-700"> · {conDiferencia} con diferencia</span>}
            {!completo && ` · contá los ${piezas.length - contadas} que faltan para ${yaRecibida ? 'terminar' : 'recibir'}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!completo || pending || confirmando}
            onClick={() => setConfirmando(true)}
            className="min-h-9 px-4 py-1.5 text-sm bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            {textoBoton}
          </button>
          <button type="button" onClick={cerrar} className="min-h-9 px-3 py-1.5 text-sm text-gray-700 rounded-lg hover:bg-gray-50">
            Cerrar
          </button>
        </div>
      </div>
      {confirmando && (
        <div role="alertdialog" aria-labelledby="conteo-cf-t" aria-describedby="conteo-cf-d" className="mx-4 sm:mx-6 mt-4 rounded-xl border-2 border-amber-600 p-4 space-y-2">
          <p id="conteo-cf-t" className="font-semibold text-gray-900">¿{textoBoton}{difs.length > 0 ? ' igual' : ''}?</p>
          <p id="conteo-cf-d" className="text-sm text-gray-700">
            {difs.length > 0 && <>{difs.length === 1 ? 'No coincide' : 'No coinciden'}: {difs.map(p => `${limpiarNombre(p.nombre)} (${llego(p)} de ${p.esperado})`).join(', ')}. </>}
            {aviso}
          </p>
          {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" autoFocus disabled={pending} onClick={marcarRecibido} className="min-h-9 px-4 py-1.5 text-sm bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
              {pending ? 'Guardando…' : `Sí, ${textoBoton.toLowerCase()}`}
            </button>
            <button type="button" onClick={() => setConfirmando(false)} className="min-h-9 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              Volver al conteo
            </button>
          </div>
        </div>
      )}
      <div className="px-4 sm:px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
        <input
          type="search"
          autoFocus
          value={busca}
          onChange={e => setBusca(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sumarUna() } }}
          placeholder="Código de la pieza en la mano + Enter (suma 1)"
          aria-label="Código de la pieza en la mano"
          className="w-full sm:w-96 min-h-9 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        <span aria-hidden="true" className="h-1.5 flex-1 min-w-24 max-w-64 rounded-full bg-gray-100 overflow-hidden">
          <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${piezas.length ? (contadas / piezas.length) * 100 : 0}%` }} />
        </span>
        <span role="status" className={`text-sm font-semibold ${ultimo?.malo ? 'text-red-700' : 'text-green-700'}`}>{ultimo?.texto}</span>
        {medible?.estimada && (
          <FormConResultado
            key={medible.clave}
            action={medirPieza.bind(null, medible.estimada.productId)}
            className="basis-full flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs"
          >
            <span className="text-amber-900">
              <span className="font-semibold">{limpiarNombre(medible.nombre)}</span> tiene peso y medidas estimados. ¿La pesás? (opcional, con su bolsa o caja)
            </span>
            {([['weightGrams', 'g', medible.estimada.weightGrams], ['dimL', 'L cm', medible.estimada.dimL], ['dimA', 'A cm', medible.estimada.dimA], ['dimH', 'H cm', medible.estimada.dimH]] as const).map(([name, label, est]) => (
              <label key={name} className="flex items-center gap-1 text-gray-600">
                {label}
                <input
                  name={name}
                  type="number"
                  min={0}
                  step="any"
                  required
                  placeholder={est != null ? String(est) : ''}
                  className="w-16 border border-gray-300 rounded px-1.5 py-0.5 text-right font-mono bg-white"
                />
              </label>
            ))}
            <PendingButton pendingLabel="Guardando…" className="px-2.5 py-1 rounded bg-amber-600 text-white font-semibold hover:bg-amber-700 disabled:opacity-50">
              Guardar medida
            </PendingButton>
            <button type="button" onClick={() => setAMedir(null)} className="text-gray-500 hover:text-gray-800 underline">
              Omitir
            </button>
          </FormConResultado>
        )}
      </div>
      <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs text-gray-600">
            <th scope="col" className="text-left px-4 sm:px-6 py-2 font-semibold">Pieza</th>
            <th scope="col" className="text-right px-3 py-2 font-semibold w-24">Esperado</th>
            <th scope="col" className="text-right px-3 py-2 font-semibold w-36">Llegó</th>
            <th scope="col" className="text-left px-3 py-2 font-semibold w-36">Resultado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {visibles.map(p => {
            const n = llego(p)
            const dif = n == null ? null : n - p.esperado
            return (
              <tr key={p.clave} className={dif != null && dif !== 0 ? 'bg-red-50/60' : ''}>
                <td className="px-4 sm:px-6 py-2 min-w-48">
                  <span className="text-gray-900">{limpiarNombre(p.nombre)}</span>
                  {p.codigo && <span className="ml-2 font-mono text-xs text-gray-600">{p.codigo}</span>}
                  {p.estimada && (
                    <button
                      type="button"
                      onClick={() => setAMedir(p.clave)}
                      title="Peso y medidas estimados: pesala ahora que la tenés"
                      className="ml-2 min-h-6 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 hover:bg-amber-200"
                    >
                      pesar
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">
                  {p.esperado}
                  {p.sinEnviar > 0 && (
                    <span title="El proveedor no las mandó: no se esperan en esta caja" className="block text-xs font-sans text-orange-800">
                      +{p.sinEnviar} sin enviar
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => anotar(p.clave, String(p.esperado))}
                      title="Llegó todo"
                      aria-label={`Llegaron las ${p.esperado} de ${p.nombre}`}
                      className="min-h-8 min-w-8 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      ✓
                    </button>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={conteo[p.clave] ?? ''}
                      onChange={e => anotar(p.clave, e.target.value)}
                      aria-label={`Cuántas llegaron de ${p.nombre}`}
                      className="w-16 min-h-8 border border-gray-300 rounded-md px-2 py-0.5 text-right font-mono text-sm"
                    />
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {dif == null ? (
                    <span className="text-xs text-gray-600">sin contar</span>
                  ) : dif === 0 ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800"><span aria-hidden="true">✓ </span>completo</span>
                  ) : dif < 0 ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-800">faltan {-dif}</span>
                  ) : (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">sobran {dif}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </section>
  )
}

// El botón que abre el conteo, arriba a la derecha de la caja.
export function BotonConteo({ yaRecibida }: { yaRecibida: boolean }) {
  return (
    <a
      href="#conteo"
      className="inline-flex items-center min-h-9 px-4 py-1.5 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 transition-colors font-medium text-gray-700"
    >
      {yaRecibida ? 'Contar caja' : 'Contar y recibir'}
    </a>
  )
}
