'use client'

import { Fragment, useState, useTransition } from 'react'
import CopiarJson from '@/components/CopiarJson'
import { embarqueAJson, type LineaFuente } from '@/lib/export-embarque'
import type { OpcionProveedor } from '@/lib/comparar-proveedores'
import { cambiarProveedor } from '@/app/(pages)/envios/linea-actions'

// Comparación de proveedores para el embarque que se está armando.
//
// El total es lo único que decide, y por eso la tabla está ordenada por él: la suma de las
// piezas por separado no alcanza, porque el FOB es fijo por embarque y no se prorratea.
// La cobertura va al lado del precio a propósito — un proveedor que cotiza 3 de 20 piezas
// se ve barato solo porque las otras 17 caen al precio base de 99rpm.
//
// Y la cobertura se ABRE: el "3/20" alcanza para descartar a un proveedor, pero no para
// hacer nada con él. Lo que sigue a "no me cotiza 17" es "¿cuáles?" — esas son las que hay
// que pedirle a otro, y por eso la lista se puede sacar como JSON directo desde acá.

const usd = (n: number) => `$${n.toFixed(2)}`

export interface PiezaEmbarque extends LineaFuente {
  productId: number
}

export default function CompararProveedores({
  envioId,
  opciones,
  editable,
  piezas,
  embarque,
}: {
  envioId: number
  opciones: OpcionProveedor[]
  editable: boolean
  /** Las líneas del embarque, para poder nombrar las que faltan y exportarlas. */
  piezas: PiezaEmbarque[]
  /** Nombre del embarque, para el JSON que se copia. */
  embarque: string
}) {
  const [pending, startTransition] = useTransition()
  // Una fila abierta a la vez: dos listas de faltantes abiertas no se comparan entre sí
  // (son de proveedores distintos), solo empujan la tabla hacia abajo.
  const [abierta, setAbierta] = useState<string | null>(null)

  if (opciones.length === 0) return null

  const actual = opciones.find(o => o.esActual)
  // La recomendación solo puede salir de una opción comprable de verdad.
  const mejor = opciones.find(o => o.viable)
  const ahorro = actual && mejor && !mejor.esActual ? actual.totalUsd - mejor.totalUsd : 0

  const porId = new Map(piezas.map(p => [p.productId, p]))
  const columnas = editable ? 9 : 8

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900">¿A quién le conviene comprarle?</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Mismo contenido, distinto proveedor. Se compara el embarque completo porque el FOB es fijo por caja:
          no se puede repartir por pieza y comparar después. Tocá la cobertura para ver qué piezas no cotiza cada uno.
        </p>
      </div>

      {mejor && ahorro > 0.5 && (
        <p className="bg-green-50 border border-green-200 text-green-900 rounded-lg px-4 py-3 text-sm">
          Comprándole a <span className="font-semibold">{mejor.nombre}</span> este embarque sale{' '}
          <span className="font-semibold">{usd(ahorro)}</span> más barato que con el proveedor actual.
          {mejor.piezasCotizadas < mejor.totalPiezas && (
            <>
              {' '}Ojo: solo cotiza {mejor.piezasCotizadas} de {mejor.totalPiezas} piezas — las otras{' '}
              {mejor.totalPiezas - mejor.piezasCotizadas} entran al precio base de 99rpm, y por barco no se las
              podrías comprar a él.
            </>
          )}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
              <th className="text-left py-2 pr-3 font-semibold">Proveedor</th>
              <th className="text-right py-2 px-2 font-semibold" title="Cuántas piezas del embarque cotiza. Las que no, caen al precio base de 99rpm">
                Cobertura
              </th>
              <th className="text-right py-2 px-2 font-semibold">Piezas</th>
              <th className="text-right py-2 px-2 font-semibold">m³</th>
              <th className="text-right py-2 px-2 font-semibold">Flete</th>
              <th className="text-right py-2 px-2 font-semibold">FOB</th>
              <th className="text-right py-2 px-2 font-semibold">Total</th>
              <th className="text-right py-2 pl-2 font-semibold">vs actual</th>
              {editable && <th className="w-24 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {opciones.map(o => {
              const delta = actual ? o.totalUsd - actual.totalUsd : 0
              const parcial = o.piezasCotizadas < o.totalPiezas
              const key = String(o.supplierId ?? 'base')
              const expandible = o.noCotizadas.length > 0
              const abierto = abierta === key
              const faltantes = abierto
                ? o.noCotizadas.map(id => porId.get(id)).filter((p): p is PiezaEmbarque => p != null)
                : []
              const sinPrecio = new Set(o.sinPrecioIds)

              return (
                <Fragment key={key}>
                <tr
                  className={o.esActual ? 'bg-cyan-50/60' : !o.viable ? 'opacity-50' : 'hover:bg-gray-50'}
                >
                  <td className="py-2.5 pr-3">
                    <span className="font-medium text-gray-900">{o.nombre}</span>
                    {o.esActual && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800">
                        actual
                      </span>
                    )}
                    {!o.viable && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600"
                        title="No cotiza ninguna pieza de este embarque: no se le puede comprar">
                        no cotiza nada
                      </span>
                    )}
                    {o.sinPrecio > 0 && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800"
                        title="Piezas que nadie cotiza: entran como 0 y dejan el total corto">
                        {o.sinPrecio} sin precio
                      </span>
                    )}
                  </td>
                  <td className={`py-2.5 px-2 text-right font-mono ${parcial ? 'text-amber-700' : 'text-gray-500'}`}>
                    {expandible ? (
                      <button
                        type="button"
                        onClick={() => setAbierta(abierto ? null : key)}
                        title={`Ver las ${o.noCotizadas.length} piezas que ${o.nombre} no cotiza`}
                        className="hover:underline underline-offset-2"
                      >
                        {o.piezasCotizadas}/{o.totalPiezas}
                        <span className="ml-1 text-[10px] not-italic">{abierto ? '▾' : '▸'}</span>
                      </button>
                    ) : (
                      <>{o.piezasCotizadas}/{o.totalPiezas}</>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono text-gray-700">{usd(o.costoOrigenUsd)}</td>
                  <td className="py-2.5 px-2 text-right font-mono text-gray-500">{o.volumeM3.toFixed(3)}</td>
                  <td className="py-2.5 px-2 text-right font-mono text-gray-500">{usd(o.fleteUsd)}</td>
                  <td className="py-2.5 px-2 text-right font-mono text-gray-500">
                    {usd(o.fobUsd)}
                    {o.fobPorDefecto && (
                      <span className="block text-[10px] text-gray-400" title="Este proveedor no tiene FOB propio cargado">
                        default
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono font-semibold text-gray-900">{usd(o.totalUsd)}</td>
                  <td className={`py-2.5 pl-2 text-right font-mono font-semibold ${
                    o.esActual ? 'text-gray-300' : delta < 0 ? 'text-green-700' : 'text-red-600'
                  }`}>
                    {o.esActual ? '—' : `${delta < 0 ? '−' : '+'}${usd(Math.abs(delta)).slice(1)}`}
                  </td>
                  {editable && (
                    <td className="py-2.5 text-right">
                      {!o.esActual && o.viable && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => startTransition(() => { cambiarProveedor(envioId, o.supplierId) })}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
                        >
                          Usar este
                        </button>
                      )}
                    </td>
                  )}
                </tr>

                {/* Lo que este proveedor NO cotiza. Va debajo de su fila y no en un panel
                    aparte porque es un detalle de ESA fila: leído solo, "17 piezas" no dice
                    de quién. */}
                {abierto && (
                  <tr className="bg-amber-50/40">
                    <td colSpan={columnas} className="px-3 py-3 whitespace-normal">
                      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                        <p className="text-xs text-gray-600">
                          <span className="font-semibold text-gray-800">
                            {o.nombre} no cotiza {o.noCotizadas.length} de {o.totalPiezas} piezas.
                          </span>{' '}
                          En el total de arriba entran al precio base de 99rpm, pero por barco no se las podés
                          comprar a él: o se las pedís a otro, o salen de la caja.
                        </p>
                        <CopiarJson
                          obtener={() => embarqueAJson(
                            {
                              embarque,
                              proveedor: null,
                              nota: `Piezas que ${o.nombre} no cotiza`,
                            },
                            faltantes,
                          )}
                          label={`Copiar las ${faltantes.length} faltantes`}
                          title="Copiar como JSON la lista de piezas que este proveedor no cotiza"
                          className="shrink-0 border border-gray-300 text-gray-700 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white transition-colors"
                        />
                      </div>
                      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
                        {faltantes.map(p => (
                          <li key={p.productId} className="text-xs text-gray-700 flex gap-2 min-w-0">
                            <span className="font-mono text-gray-400 shrink-0">{p.bajajCode ?? '—'}</span>
                            <span className="truncate">{p.nameEs}</span>
                            <span className="ml-auto font-mono text-gray-500 shrink-0">×{p.quantity}</span>
                            {sinPrecio.has(p.productId) && (
                              <span className="text-[10px] font-semibold text-amber-700 shrink-0" title="Tampoco tiene precio base: entra al total como 0">
                                sin precio
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        El flete puede diferir entre proveedores: el que cotiza puesto en Venezuela no manda esa pieza en el
        contenedor, así que no ocupa volumen. El mínimo facturable de la naviera se aplica igual en todos.
      </p>
    </div>
  )
}
