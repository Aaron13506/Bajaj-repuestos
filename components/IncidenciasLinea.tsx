'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import CamposDevolucion from '@/components/CamposDevolucion'
import type { ActionResult } from '@/lib/action-result'
import {
  RESOLUCION_LABELS, TIPO_AYUDA, TIPO_LABELS, perdidaSugerida, resolucionesPara, planReembolso,
  type OrigenIncidencia, type Resolucion, type TipoIncidencia,
} from '@/lib/incidencias'

// Los problemas de UNA línea de un pedido: los que están anotados (abiertos y resueltos) y los
// formularios para anotar uno nuevo o cerrar uno abierto. Ver lib/incidencias.ts para qué hace cada
// resolución con la plata — acá solo se ofrece, y el servidor lo vuelve a verificar todo.

export interface IncidenciaVista {
  id: number
  tipo: TipoIncidencia
  origen: OrigenIncidencia
  cantidad: number
  nota: string | null
  estado: 'abierta' | 'resuelta'
  resolucion: Resolucion | null
  perdidaUsd: number | null
  reposicionId: number | null
  creadaAt: string
  /** La pieza del conjunto que es el problema (null = la línea entera). */
  pieza: string | null
}

/** Una pieza del conjunto de la línea, para poder señalar cuál es la que falla. */
export interface PiezaVista {
  etiqueta: string
  /** Unidades por set. */
  quantity: number
}

interface Props {
  itemId: number
  /** Qué se puede anotar en la etapa en que está la línea (vacío si el pedido no admite incidencias). */
  tipos: TipoIncidencia[]
  /** Si la línea es un conjunto: sus piezas (casi nunca falta todo, falta un SKU). */
  piezas?: PiezaVista[]
  /** A dónde ir a editar el pedido (quitar la pieza que no hay cierra el problema). */
  editarHref?: string
  /** La línea, para proponer cifras al reembolsar. */
  linea: { quantity: number; salePrice: number; costRealUsd: number | null }
  /** Lo que vale el pedido entero y lo que tiene cobrado (reales), para saber cuánto le sobraría al cliente. */
  pedido: { totalReal: number; depositUsd: number }
  tasaSugerida: number
  incidencias: IncidenciaVista[]
  reportar: (itemId: number, formData: FormData) => Promise<ActionResult>
  resolver: (incidenciaId: number, formData: FormData) => Promise<ActionResult>
}

const cls = 'w-full border border-gray-300 rounded-lg px-2.5 py-1 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })

function FormReportar({
  itemId, tipos, cantidadLinea, piezas, reportar, cerrar,
}: { itemId: number; tipos: TipoIncidencia[]; cantidadLinea: number; piezas: PiezaVista[]; reportar: Props['reportar']; cerrar: () => void }) {
  const [tipo, setTipo] = useState<TipoIncidencia>(tipos[0])
  const [pieza, setPieza] = useState('')
  // Solo "no disponible" se anota sobre UNA pieza: el resto (dañada, incompleta…) es de unidades de la línea.
  const porPieza = tipo === 'no_disponible' && piezas.length > 0
  const { enviar, isPending, error } = useEnviarAccion(fd => reportar(itemId, fd), cerrar)
  return (
    <form onSubmit={enviar} className="mt-1.5 p-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
      <div className={porPieza && pieza ? '' : 'grid grid-cols-[1fr_5rem] gap-2'}>
        <select name="tipo" value={tipo} onChange={e => setTipo(e.target.value as TipoIncidencia)} className={cls}>
          {tipos.map(t => <option key={t} value={t}>{TIPO_LABELS[t]}</option>)}
        </select>
        {!(porPieza && pieza) && (
          <input
            type="number" name="cantidad" min={1} max={cantidadLinea} defaultValue={cantidadLinea} required
            title="Cuántas unidades" className={`${cls} text-center`}
          />
        )}
      </div>
      {porPieza && (
        <div>
          <label className="block text-[11px] font-medium text-amber-900 mb-0.5">¿Cuál pieza del conjunto?</label>
          <select name="pieza" value={pieza} onChange={e => setPieza(e.target.value)} className={cls}>
            <option value="">Todo el conjunto</option>
            {piezas.map(p => <option key={p.etiqueta} value={p.etiqueta}>{p.quantity}× {p.etiqueta}</option>)}
          </select>
          {pieza && <p className="text-[10px] text-amber-700 mt-0.5">Las demás piezas siguen su curso: al editar el pedido quitás solo esta.</p>}
        </div>
      )}
      <p className="text-[11px] text-amber-800">{TIPO_AYUDA[tipo]}</p>
      <input type="text" name="nota" placeholder="Nota (opcional)" className={cls} />
      {error && <p role="alert" className="text-[11px] text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40">
          {isPending ? 'Guardando…' : 'Anotar problema'}
        </button>
        <button type="button" onClick={cerrar} className="px-2 py-1 text-xs text-gray-500 hover:bg-white rounded-lg">Cancelar</button>
      </div>
    </form>
  )
}

function FormResolver({
  inc, linea, pedido, tasaSugerida, resolver, cerrar,
}: { inc: IncidenciaVista } & Pick<Props, 'linea' | 'pedido' | 'tasaSugerida' | 'resolver'> & { cerrar: () => void }) {
  const opciones = resolucionesPara(inc.tipo, inc.origen)
  const [resolucion, setResolucion] = useState<Resolucion>(opciones[0])
  const { enviar, isPending, error } = useEnviarAccion(fd => resolver(inc.id, fd), cerrar)

  // Lo que va a pasar si se reembolsa: cuánto sale del pedido, cuánto se pierde y cuánto le sobra al cliente.
  const sugerida = perdidaSugerida(linea.costRealUsd, linea.quantity, inc.cantidad)
  const plan = planReembolso({ ...linea }, Math.min(inc.cantidad, linea.quantity), sugerida)
  const nuevoTotal = Math.max(0, pedido.totalReal - plan.bajaVentaUsd)
  const leSobra = Math.min(pedido.depositUsd, Math.max(0, pedido.depositUsd - nuevoTotal))

  return (
    <form onSubmit={enviar} className="mt-1.5 p-2.5 bg-gray-50 border border-gray-200 rounded-lg space-y-2">
      <select name="resolucion" value={resolucion} onChange={e => setResolucion(e.target.value as Resolucion)} className={cls}>
        {opciones.map(r => <option key={r} value={r}>{RESOLUCION_LABELS[r]}</option>)}
      </select>

      {resolucion === 'reposicion' && (
        <p className="text-[11px] text-gray-600">
          Se crea un pedido nuevo a <strong>$0</strong> con {inc.cantidad} unidad(es) para volver a mandarlas. Lo que cuesta
          comprarlas otra vez queda como margen negativo de ese pedido.
        </p>
      )}
      {resolucion === 'reembolso' && (
        <div className="space-y-2">
          <p className="text-[11px] text-gray-600">
            Bajan {inc.cantidad} unidad(es) del pedido (${plan.bajaVentaUsd.toFixed(2)}). Lo que se pagó por ellas sale de la línea y queda como pérdida del pedido.
          </p>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">Pérdida (USD)</label>
            <input type="number" name="perdidaUsd" min={0} step="0.01" defaultValue={sugerida.toFixed(2)} className={`${cls} font-mono`} />
            <p className="text-[10px] text-gray-400 mt-0.5">Lo que costaron esas unidades. Bajalo si el proveedor te devolvió parte.</p>
          </div>
          {pedido.depositUsd > 0.005 && (
            <CamposDevolucion sugerido={leSobra} maximo={pedido.depositUsd} tasaSugerida={tasaSugerida} etiqueta="Devolverle al cliente (USD reales)" />
          )}
        </div>
      )}
      <input type="text" name="nota" placeholder="Nota (opcional)" className={cls} />
      {error && <p role="alert" className="text-[11px] text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
          {isPending ? 'Guardando…' : 'Resolver'}
        </button>
        <button type="button" onClick={cerrar} className="px-2 py-1 text-xs text-gray-500 hover:bg-white rounded-lg">Cancelar</button>
      </div>
    </form>
  )
}

export default function IncidenciasLinea({ itemId, tipos, piezas = [], editarHref, linea, pedido, tasaSugerida, incidencias, reportar, resolver }: Props) {
  const [reportando, setReportando] = useState(false)
  const [resolviendo, setResolviendo] = useState<number | null>(null)
  const abiertas = incidencias.filter(i => i.estado === 'abierta')
  const cerradas = incidencias.filter(i => i.estado === 'resuelta')

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {abiertas.map(i => (
          <button
            key={i.id}
            type="button"
            onClick={() => setResolviendo(resolviendo === i.id ? null : i.id)}
            title={i.nota ?? TIPO_AYUDA[i.tipo]}
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200"
          >
            ⚠ {TIPO_LABELS[i.tipo]}{i.pieza ? ` · ${i.pieza}` : ` · ${i.cantidad}×`} {i.origen === 'cliente' ? '(reclamo)' : ''} — resolver
          </button>
        ))}
        {cerradas.map(i => (
          <span
            key={i.id}
            title={[i.nota, i.perdidaUsd != null ? `Pérdida $${i.perdidaUsd.toFixed(2)}` : null].filter(Boolean).join(' · ') || undefined}
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500"
          >
            ✓ {TIPO_LABELS[i.tipo]}{i.pieza ? ` · ${i.pieza}` : ` · ${i.cantidad}×`} → {i.resolucion ? RESOLUCION_LABELS[i.resolucion] : ''} ({fecha(i.creadaAt)})
            {i.reposicionId != null && (
              <> · <Link href={`/presupuestos/${i.reposicionId}`} className="text-blue-600 hover:underline">pedido #{i.reposicionId}</Link></>
            )}
          </span>
        ))}
        {tipos.length > 0 && !reportando && (
          <button type="button" onClick={() => setReportando(true)} className="text-[10px] text-gray-400 hover:text-amber-700">
            ⚠ Reportar problema
          </button>
        )}
      </div>
      {editarHref && abiertas.some(i => i.tipo === 'no_disponible' && i.pieza) && (
        <p className="mt-1 text-[11px] text-amber-800">
          Para seguir sin esa pieza, <Link href={editarHref} className="text-blue-600 hover:underline">editá el pedido</Link> y quitala del conjunto:
          el problema se cierra solo y las demás piezas se compran igual.
        </p>
      )}
      {reportando && (
        <FormReportar itemId={itemId} tipos={tipos} cantidadLinea={linea.quantity} piezas={piezas} reportar={reportar} cerrar={() => setReportando(false)} />
      )}
      {abiertas.map(i =>
        resolviendo === i.id ? (
          <FormResolver key={i.id} inc={i} linea={linea} pedido={pedido} tasaSugerida={tasaSugerida} resolver={resolver} cerrar={() => setResolviendo(null)} />
        ) : null,
      )}
    </div>
  )
}
