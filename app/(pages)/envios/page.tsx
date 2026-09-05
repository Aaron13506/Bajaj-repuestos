import { db } from '@/lib/db'
import Link from 'next/link'
import { createEnvio } from './actions'
import { stageSummary, SHIPPING_STATUSES } from '@/lib/shipping-status'
import { inboundDe, inboundMeta } from '@/lib/inbound'

export default async function EnviosPage() {
  // Una sola tanda: ninguna de las tres depende de las otras y encadenarlas costaba
  // tres veces la latencia hasta la base.
  const [envios, sinAsignar, suppliers] = await Promise.all([
    db.envio.findMany({
      include: {
        items: { select: { id: true, shippingStatus: true, pedidoId: true } },
        lineas: { select: { id: true, quantity: true } },
        supplier: { select: { name: true, origen: true, inbound: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.pedidoItem.count({ where: { envioId: null } }),
    // Proveedores para las DOS rutas. El aéreo no los ofrecía porque por avión se le
    // compraba siempre a 99rpm; dejó de ser cierto cuando aparecieron proveedores que
    // despachan por su cuenta y hoy viajan cajas suyas en paralelo con las de Shoppre.
    db.supplier.findMany({
      select: { id: true, name: true, origen: true, inbound: true, fobUsd: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const borradores = envios.filter(e => e.modo === 'maritimo_cbm' && e.estado === 'borrador')

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Envíos</h1>
        <p className="text-sm text-gray-500 mt-1">
          Dos rutas, dos formas de llenar la caja: la aérea agrupa <span className="font-medium">pedidos de
          cliente</span>, la marítima se arma con <span className="font-medium">mercancía propia</span> pieza por pieza.
        </p>
      </div>

      {/* Un embarque marítimo en borrador es el planificador: se sigue llenando hasta que
          se cierra. Va arriba de todo porque es trabajo a medio terminar — si queda
          enterrado en la lista, se termina abriendo otro y partiendo la carga en dos. */}
      {borradores.length > 0 && (
        <div className="mb-6 space-y-2">
          {borradores.map(e => (
            <Link
              key={e.id}
              href={`/envios/${e.id}`}
              className="flex items-center justify-between gap-4 rounded-xl border-2 border-cyan-300 bg-cyan-50 px-5 py-4 hover:bg-cyan-100 transition-colors"
            >
              <div>
                <p className="font-semibold text-cyan-900">
                  🚢 {e.nombre ?? `Embarque #${e.id}`}
                  <span className="ml-2 text-xs font-normal text-cyan-700">en borrador · seguí llenándolo</span>
                </p>
                <p className="text-xs text-cyan-700 mt-0.5">
                  {e.lineas.length} {e.lineas.length === 1 ? 'pieza' : 'piezas'} cargadas
                </p>
              </div>
              <span className="text-sm font-medium text-cyan-800 shrink-0">Planificar →</span>
            </Link>
          ))}
        </div>
      )}

      {/* Crear: la ruta se elige acá y ya no se cambia — decide cómo se costea la caja y
          qué se le puede meter adentro. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {[
          {
            modo: 'aereo',
            icono: '✈️',
            titulo: 'Envío aéreo',
            desc: 'Origen → USA por aire → Venezuela. Se llena asignándole pedidos de cliente ya confirmados. El proveedor decide cómo se cobra el tramo a USA.',
            placeholder: 'Ej: Caja Julio #1',
            cls: 'border-indigo-200 bg-indigo-50/40',
            btn: 'bg-indigo-600 hover:bg-indigo-700',
          },
          {
            modo: 'maritimo_cbm',
            icono: '🚢',
            titulo: 'Embarque marítimo',
            desc: 'India → Venezuela directo por barco. Se cobra por volumen (m³ + FOB fijo). Nace en borrador y se llena con mercancía tuya.',
            placeholder: 'Ej: Embarque agosto',
            cls: 'border-cyan-200 bg-cyan-50/40',
            btn: 'bg-cyan-600 hover:bg-cyan-700',
          },
        ].map(r => (
          <form
            key={r.modo}
            action={createEnvio}
            className={`rounded-xl border p-5 flex flex-col gap-3 ${r.cls}`}
          >
            <input type="hidden" name="modo" value={r.modo} />
            <div>
              <h2 className="font-semibold text-gray-900">{r.icono} {r.titulo}</h2>
              <p className="text-xs text-gray-500 mt-1">{r.desc}</p>
            </div>
            <input
              type="text"
              name="nombre"
              placeholder={r.placeholder}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            {/* El proveedor se elige acá y queda congelado. Es la decisión que define todo
                lo demás: el precio de cada pieza, si el tramo a USA lo cobra la tabla
                escalón o lo factura él, las etapas de la ruta, y el FOB por mar. Lo que se
                asigne después a esta caja lo hereda. */}
            <label className="block">
              <span className="text-xs text-gray-500">
                Proveedor {r.modo === 'aereo' ? '(define precios y cómo llega a USA)' : '(define precios y FOB)'}
              </span>
              <select
                name="supplierId"
                defaultValue=""
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">99rpm · precio base ₹{r.modo === 'aereo' ? ' · por Shoppre' : ''}</option>
                {suppliers.map(sp => {
                  const meta = inboundMeta(inboundDe(sp.origen, sp.inbound))
                  return (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                      {r.modo === 'aereo'
                        ? ` · ${meta.label}`
                        : sp.fobUsd != null
                          ? ` · FOB $${parseFloat(sp.fobUsd.toString()).toFixed(0)}`
                          : ' · FOB por defecto'}
                    </option>
                  )
                })}
              </select>
            </label>
            <button
              type="submit"
              className={`text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors ${r.btn}`}
            >
              + Crear {r.modo === 'aereo' ? 'envío aéreo' : 'embarque marítimo'}
            </button>
          </form>
        ))}
      </div>

      <p className="text-xs text-gray-500 mb-3">
        {sinAsignar} {sinAsignar === 1 ? 'ítem sin asignar' : 'ítems sin asignar'} a un envío.
      </p>

      {envios.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
          <p className="text-lg">Sin envíos</p>
          <p className="text-sm mt-1">Elegí arriba la ruta con la que querés traer la mercancía.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {envios.map(e => {
            const esMar = e.modo === 'maritimo_cbm'
            const esBorrador = e.estado === 'borrador'
            // El aéreo se mide en ítems de pedido; el marítimo en líneas propias. Mezclar
            // los dos conteos haría ver vacía una caja que está llena de lo otro.
            const summary = esMar ? null : stageSummary(e.items)
            const pedidosEnEnvio = new Set(e.items.map(i => i.pedidoId)).size
            const lead = summary?.lead
            const pct = summary
              ? Math.round((summary.leadIndex / (SHIPPING_STATUSES.length - 1)) * 100)
              : 0
            return (
            <div
              key={e.id}
              className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs font-mono text-gray-400">#{e.id}</span>
                  <Link
                    href={`/envios/${e.id}`}
                    className="font-semibold text-gray-900 hover:text-blue-600"
                  >
                    {e.nombre ?? (esMar ? `Embarque #${e.id}` : `Envío #${e.id}`)}
                  </Link>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                    esMar ? 'bg-cyan-100 text-cyan-800' : 'bg-indigo-100 text-indigo-800'
                  }`}>
                    {esMar ? '🚢 Marítimo' : '✈️ Aéreo'}
                  </span>
                  {/* Con cajas de proveedores distintos viajando a la vez, el nombre es lo
                      primero que hay que poder leer de un vistazo en la lista. */}
                  <span
                    title={e.supplier ? inboundMeta(inboundDe(e.supplier.origen, e.supplier.inbound)).hint : undefined}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700"
                  >
                    {e.supplier
                      ? `${inboundMeta(inboundDe(e.supplier.origen, e.supplier.inbound)).icon} ${e.supplier.name}`
                      : '📦 99rpm'}
                  </span>
                  {esMar && esBorrador && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                      Borrador
                    </span>
                  )}
                  <span className="text-xs text-gray-400">
                    {esMar
                      ? `${e.lineas.length} ${e.lineas.length === 1 ? 'pieza' : 'piezas'}`
                      : `${e.items.length} ${e.items.length === 1 ? 'ítem' : 'ítems'}${pedidosEnEnvio > 0 ? ` · ${pedidosEnEnvio} ${pedidosEnEnvio === 1 ? 'pedido' : 'pedidos'}` : ''}`}
                  </span>
                  {summary && lead && (
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${lead.badge}`}>
                      {lead.icon} {summary.allDelivered ? 'Entregado' : lead.short}
                      {summary.mixed && !summary.allDelivered && ' +'}
                    </span>
                  )}
                </div>
                {summary && summary.comprados > 0 && (
                  <div className="mt-2 flex items-center gap-2 max-w-xs">
                    <div className="h-1.5 flex-1 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${summary.allDelivered ? 'bg-green-500' : 'bg-blue-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {summary.pendientes > 0 && (
                      <span className="text-[10px] text-gray-400 shrink-0">{summary.pendientes} por comprar</span>
                    )}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {new Date(e.createdAt).toLocaleDateString('es-VE', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                  {e.notas && ` · ${e.notas}`}
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                {e.shippingCostEst != null && (
                  <span className="text-xs text-gray-500">
                    Flete est. <span className="font-mono font-semibold text-gray-800">${parseFloat(e.shippingCostEst.toString()).toFixed(2)}</span>
                  </span>
                )}
                <Link href={`/envios/${e.id}`} className="text-sm text-blue-600 hover:text-blue-800">
                  {esMar && esBorrador ? 'Llenar' : 'Ver'}
                </Link>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
