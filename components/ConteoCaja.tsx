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
  function marcarRecibido() {
    const texto = conDiferencia > 0
      ? `${conDiferencia} ${conDiferencia === 1 ? 'pieza no coincide' : 'piezas no coinciden'} con lo esperado.\n\n${aviso}\n\n¿${textoBoton} igual?`
      : `${aviso}\n\n¿${textoBoton}?`
    if (!confirm(texto)) return
    ejecutar(async () => {
      const r = await recibir()
      if (r.ok) {
        try { localStorage.removeItem(clave) } catch {}
        setConteo({})
        cerrar()
      }
      return r
    })
  }

  if (!abierto) return null

  return (
    <div id="conteo" className="scroll-mt-4 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
      <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Conteo de la caja · {contadas}/{piezas.length} contadas
          {conDiferencia > 0 && <span className="ml-2 text-red-600 normal-case">{conDiferencia} con diferencia</span>}
        </h2>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-red-600 font-medium">{error}</span>}
          <button
            type="button"
            disabled={!completo || pending}
            onClick={marcarRecibido}
            title={completo ? undefined : 'Contá todas las piezas primero'}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors font-medium"
          >
            {pending ? 'Guardando…' : textoBoton}
          </button>
          <button type="button" onClick={cerrar} className="text-xs text-gray-500 hover:text-gray-800 underline">
            Cerrar
          </button>
        </div>
      </div>
      <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
        <input
          type="search"
          autoFocus
          value={busca}
          onChange={e => setBusca(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sumarUna() } }}
          placeholder="Código de la pieza en la mano + Enter (suma 1)"
          aria-label="Buscar pieza por código o nombre"
          className="w-full sm:w-96 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        {ultimo && (
          <span className={`text-xs font-semibold ${ultimo.malo ? 'text-red-600' : 'text-green-700'}`}>{ultimo.texto}</span>
        )}
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
            <th className="text-left px-6 py-2 font-semibold">Pieza</th>
            <th className="text-right px-3 py-2 font-semibold w-24">Esperado</th>
            <th className="text-right px-3 py-2 font-semibold w-32">Llegó</th>
            <th className="text-left px-3 py-2 font-semibold w-32" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {visibles.map(p => {
            const n = llego(p)
            const dif = n == null ? null : n - p.esperado
            return (
              <tr key={p.clave} className={dif != null && dif !== 0 ? 'bg-red-50/60' : ''}>
                <td className="px-6 py-2">
                  <span className="text-gray-900">{limpiarNombre(p.nombre)}</span>
                  {p.codigo && <span className="ml-2 font-mono text-[10px] text-gray-400">{p.codigo}</span>}
                  {p.estimada && (
                    <button
                      type="button"
                      onClick={() => setAMedir(p.clave)}
                      title="Peso y medidas estimados: pesala ahora que la tenés"
                      className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200"
                    >
                      pesar
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">{p.esperado}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => anotar(p.clave, String(p.esperado))}
                      title="Llegó todo"
                      aria-label={`Llegaron las ${p.esperado} de ${p.nombre}`}
                      className="px-1.5 py-0.5 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
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
                      className="w-16 border border-gray-300 rounded px-2 py-0.5 text-right font-mono text-sm"
                    />
                  </div>
                </td>
                <td className="px-3 py-2 text-xs font-semibold">
                  {dif == null ? null : dif === 0 ? (
                    <span className="text-green-700">✓ completo</span>
                  ) : dif < 0 ? (
                    <span className="text-red-700">faltan {-dif}</span>
                  ) : (
                    <span className="text-amber-700">sobran {dif}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// El botón que abre el conteo, arriba a la derecha de la caja.
export function BotonConteo({ yaRecibida }: { yaRecibida: boolean }) {
  return (
    <a
      href="#conteo"
      className="px-4 py-2 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 transition-colors font-medium text-gray-700"
    >
      {yaRecibida ? 'Contar caja' : 'Contar y recibir'}
    </a>
  )
}
