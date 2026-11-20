import Link from 'next/link'
import { db } from '@/lib/db'
import { limpiarNombre } from '@/lib/utils'
import { DECISION_LABEL, esDecision } from '@/lib/recepcion'
import { estimadasDe, pendienteDeRecibir, vistaRecepcion } from '@/lib/recepcion-db'
import { MOTIVO_STOCK_LABEL, type MotivoStock } from '@/lib/stock'
import { TIPO_LABELS, esTipoIncidencia } from '@/lib/incidencias'
import SeccionCaja from '@/components/SeccionCaja'
import ConteoCaja from '@/components/ConteoCaja'
import QrEnlace from '@/components/QrEnlace'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import CamposBulto from '@/components/CamposBulto'
import { cajasQueSeFacturan } from '@/lib/cajas-envio'
import { abrirConteo, marcarLlegada, revertirEnRecepcion } from '../recepcion-actions'

const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Caracas' })

// La pestaña Llegada de una caja (aérea o marítima): marcar la llegada, contar (la recepción
// abierta, emparejada con el teléfono por QR) y las recepciones cerradas, en solo lectura.
export default async function RecepcionesCaja({ envioId }: { envioId: number }) {
  const envio = await db.envio.findUniqueOrThrow({
    where: { id: envioId },
    select: {
      id: true, modo: true, estado: true, llegadaAt: true, llegadaNota: true,
      llegadaPesoKg: true, llegadaLargoCm: true, llegadaAnchoCm: true, llegadaAltoCm: true,
      reempaque: true, cajas: { select: { etapa: true, pesoKg: true } },
      recepciones: {
        orderBy: { id: 'desc' },
        select: {
          id: true, abiertaAt: true, cerradaAt: true, revertidaAt: true,
          lineas: { select: { id: true, codigo: true, nombre: true, esperado: true, contado: true, decision: true, productId: true }, orderBy: { nombre: 'asc' } },
          incidencias: { select: { id: true, pedidoId: true, tipo: true, cantidad: true, descripcion: true, pieza: true, estado: true } },
          movimientosStock: { select: { productId: true, cantidad: true, motivo: true } },
        },
      },
    },
  })
  const volver = `/envios/${envioId}#llegada`
  if (envio.estado === 'borrador') {
    return <p className="mb-4 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-600">En borrador no hay nada que contar.</p>
  }
  const abierta = envio.recepciones.find(r => !r.cerradaAt)
  const cerradas = envio.recepciones.filter(r => r.cerradaAt)
  const [vista, pendiente] = await Promise.all([
    abierta ? vistaRecepcion(abierta.id) : null,
    abierta ? [] : pendienteDeRecibir(envio),
  ])

  // Las de peso y medidas estimados (o medidas sin base) se ofrecen medir al contarlas.
  const estimadas = await estimadasDe(vista?.lineas.flatMap(l => (l.codigo ? [l.codigo] : [])) ?? [])
  const ultima = envio.recepciones[0]

  // El bulto como lo pesé al llegar, al lado de lo que pesó el transportista (las cajas que se
  // facturan, si están todas pesadas). Solo se muestra: el costeo sigue con las del transportista.
  const facturadas = cajasQueSeFacturan(envio.reempaque, envio.cajas).cajas
  const kgTransportista = facturadas.length > 0 && facturadas.every(c => c.pesoKg != null)
    ? facturadas.reduce((s, c) => s + Number(c.pesoKg), 0) : null
  const bulto = envio.llegadaPesoKg != null || envio.llegadaLargoCm != null
    ? [
        envio.llegadaPesoKg != null && `pesó ${Number(envio.llegadaPesoKg)} kg`,
        envio.llegadaLargoCm != null && `${envio.llegadaLargoCm}×${envio.llegadaAnchoCm}×${envio.llegadaAltoCm} cm`,
        kgTransportista != null && `el transportista: ${+kgTransportista.toFixed(3)} kg`,
      ].filter(Boolean).join(' · ')
    : null

  return (
    <>
      <SeccionCaja
        id="llegada-titulo"
        titulo={vista ? 'Contar y recibir' : envio.llegadaAt ? 'La caja llegó' : 'Todavía no llegó'}
        sub={<>
          {envio.llegadaAt ? `Llegó el ${fecha(envio.llegadaAt)}${envio.llegadaNota ? ` · ${envio.llegadaNota}` : ''}${bulto ? ` · ${bulto}` : ''}.` : 'Marcá la llegada cuando la tengas en la mano: eso abre el conteo. Peso y medidas del bulto, si lo pesás.'}
          {!vista && pendiente.length > 0 && ` ${pendiente.length} ${pendiente.length === 1 ? 'código' : 'códigos'} por recibir.`}
          {!vista && pendiente.length === 0 && envio.recepciones.length === 0 && envio.llegadaAt && ' Recibida antes del registro de recepciones.'}
          {!vista && pendiente.length === 0 && !envio.llegadaAt && ' Todavía no hay nada comprado que contar.'}
        </>}
        acciones={!vista && pendiente.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {!envio.llegadaAt ? (
              <>
                <FormConResultado action={marcarLlegada.bind(null, envioId)} className="flex flex-wrap items-center gap-2">
                  <input name="nota" placeholder="Nota (opcional): llegó golpeada…" aria-label="Nota de la llegada" className="min-h-9 w-56 rounded-lg border border-gray-300 px-3 text-sm" />
                  <CamposBulto />
                  <PendingButton pendingLabel="Marcando…" className="min-h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Marcar llegada</PendingButton>
                </FormConResultado>
                <FormConResultado action={abrirConteo.bind(null, envioId)}>
                  <PendingButton pendingLabel="Abriendo…" className="min-h-9 rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">Contar sin marcar llegada</PendingButton>
                </FormConResultado>
              </>
            ) : (
              <FormConResultado action={abrirConteo.bind(null, envioId)}>
                <PendingButton pendingLabel="Abriendo…" className="min-h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {cerradas.length > 0 ? 'Contar lo que faltaba' : 'Contar y recibir'}
                </PendingButton>
              </FormConResultado>
            )}
          </div>
        ) : null}
      >
        {vista && (
          <div className="space-y-4 px-4 py-4 sm:px-6">
            <QrEnlace ruta={`/escanear/recepcion/${vista.id}`} base={process.env.APP_URL?.trim().replace(/\/+$/, '') || null}
              texto="Escaneá este QR con el teléfono para contar ahí; esta pantalla muestra el progreso." />
            <ConteoCaja vista={vista} volver={volver} estimadas={estimadas} refrescar />
          </div>
        )}
      </SeccionCaja>

      {cerradas.map(r => {
        const sumado = r.movimientosStock.filter(m => m.cantidad > 0).reduce((s, m) => s + m.cantidad, 0)
        const porMotivo = new Map<string, number>()
        for (const m of r.movimientosStock) porMotivo.set(m.motivo, (porMotivo.get(m.motivo) ?? 0) + m.cantidad)
        return (
          <SeccionCaja
            key={r.id}
            id={`recepcion-${r.id}`}
            titulo={<>Recepción #{r.id}{r.revertidaAt && <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">revertida</span>}</>}
            sub={`Cerrada el ${fecha(r.cerradaAt!)}${r.revertidaAt ? ` · revertida el ${fecha(r.revertidaAt)}` : ''} · ${[...porMotivo].map(([m, n]) => `${MOTIVO_STOCK_LABEL[m as MotivoStock] ?? m} ${n > 0 ? '+' : ''}${n}`).join(' · ') || 'sin movimientos de stock'}`}
            acciones={r === ultima && !r.revertidaAt ? (
              <FormConResultado action={revertirEnRecepcion.bind(null, r.id, envioId)}>
                <PendingButton
                  confirmMessage={`¿Revertir la recepción #${r.id}? Resta del stock lo que sumó (${sumado} u.), borra sus incidencias abiertas, devuelve las líneas a "camino a Venezuela" y abre un conteo nuevo.`}
                  pendingLabel="Revirtiendo…"
                  className="min-h-9 rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Revertir recepción
                </PendingButton>
              </FormConResultado>
            ) : null}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-600">
                    <th scope="col" className="px-4 py-2 text-left font-semibold sm:px-6">Pieza</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Esperado</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Contado</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Diferencia</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">Decisión</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {r.lineas.map(l => {
                    const dif = (l.contado ?? 0) - l.esperado
                    return (
                      <tr key={l.id} className={dif !== 0 ? 'bg-red-50/60' : ''}>
                        <td className="px-4 py-2 sm:px-6">
                          {l.productId ? <Link href={`/products/${l.productId}`} className="text-gray-900 hover:underline">{limpiarNombre(l.nombre)}</Link> : <span className="text-gray-900">{limpiarNombre(l.nombre)}</span>}
                          <span className="ml-2 font-mono text-xs text-gray-600">{l.codigo ?? 'sin identificar'}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{l.esperado}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.contado ?? '—'}</td>
                        <td className={`px-3 py-2 text-right font-mono ${dif < 0 ? 'text-red-700' : dif > 0 ? 'text-amber-800' : 'text-gray-600'}`}>{dif > 0 ? `+${dif}` : dif}</td>
                        <td className="px-3 py-2 text-gray-700">{l.decision && esDecision(l.decision) ? DECISION_LABEL[l.decision] : dif > 0 ? 'Sobrante a $0' : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {r.incidencias.length > 0 && (
              <ul aria-label="Incidencias que dejó" className="space-y-1 border-t border-gray-100 px-4 py-3 text-sm sm:px-6">
                {r.incidencias.map(i => (
                  <li key={i.id}>
                    <Link href={`/presupuestos/${i.pedidoId}`} className="text-blue-700 hover:underline">Pedido #{i.pedidoId}</Link>
                    {' · '}{esTipoIncidencia(i.tipo) ? TIPO_LABELS[i.tipo] : i.tipo}: {i.cantidad} × {limpiarNombre(i.pieza ?? i.descripcion)}
                    {i.estado !== 'abierta' && <span className="text-gray-600"> (resuelta)</span>}
                  </li>
                ))}
              </ul>
            )}
          </SeccionCaja>
        )
      })}
    </>
  )
}
