'use client'

import { useState } from 'react'
import CampoFecha from '@/components/CampoFecha'
import { cobraEnBolivares } from '@/lib/pagos'
import MontoBs from '@/components/MontoBs'
import { useEnviarAccion } from '@/components/useEnviarAccion'
import type { ActionResult } from '@/lib/action-result'

interface Categoria {
  value: string
  label: string
}

interface Pedido {
  id: number
  clientName: string
}

interface Envio {
  id: number
  nombre: string | null
  estado: string
}

interface Supplier {
  id: number
  name: string
}

interface Props {
  action: (formData: FormData) => Promise<ActionResult>
  /** Entra o sale plata: lo elige el selector de arriba (AnotarLibro), no la categoría. */
  tipo: 'ingreso' | 'egreso'
  categoriasIngreso: Categoria[]
  categoriasEgreso: Categoria[]
  metodosIngreso: readonly string[]
  metodosEgreso: readonly string[]
  pedidos: Pedido[]
  envios: Envio[]
  suppliers: Supplier[]
  /** Tasas (Bs por USD) a proponer en un ingreso en bolívares: la de cobro directo, y la BCV si es de un pedido. */
  tasaBsSugerida: number
  tasaBcvSugerida: number
  /** Bs por USD a los que el libro tiene los Bs del banco: la tasa a proponer en un egreso en Bs. */
  tasaLibroBs: number
}

// Ingreso y egreso son dos formularios distintos que comparten fecha/monto/nota: un
// ingreso cobra en efectivo/Bs/cripto y se liga a un PEDIDO (el cliente); un egreso se
// paga por giro/tarjeta/cripto y se liga a un ENVÍO/PROVEEDOR — nunca a un pedido. Antes
// se mostraban los seis campos siempre, y "método de pago" ofrecía "Transferencia Bs"
// para pagarle a un proveedor en India, lo que no corresponde a ningún medio real.
const CAMPO = 'h-10 w-full border border-gray-300 rounded-lg px-3 text-base sm:text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
const ETIQUETA = 'flex flex-col gap-1 text-xs font-medium text-gray-600 min-w-0'

export default function MovimientoForm({
  action,
  tipo,
  categoriasIngreso,
  categoriasEgreso,
  metodosIngreso,
  metodosEgreso,
  pedidos,
  envios,
  suppliers,
  tasaBsSugerida,
  tasaBcvSugerida,
  tasaLibroBs,
}: Props) {
  const esEgreso = tipo === 'egreso'
  const categorias = esEgreso ? categoriasEgreso : categoriasIngreso
  const [metodo, setMetodo] = useState('')
  const [pedidoId, setPedidoId] = useState('')
  const [monto, setMonto] = useState('')
  const { enviar, isPending, error } = useEnviarAccion(action, form => {
    form.reset()
    setMetodo('')
    setPedidoId('')
    setMonto('')
  })

  const metodos = esEgreso ? metodosEgreso : metodosIngreso
  // Un cobro en Bs de un pedido se escribe en dólares BCV (el servidor guarda su valor real).
  const enBs = cobraEnBolivares(metodo)
  const enBsDePedido = enBs && !esEgreso && pedidoId !== ''

  return (
    <form onSubmit={enviar} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      <label className={ETIQUETA}>
        Categoría
        <select name="categoria" defaultValue={categorias[0]?.value} className={CAMPO}>
          {categorias.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <label className={ETIQUETA}>
        Método de pago
        <select name="metodoPago" value={metodo} onChange={e => setMetodo(e.target.value)} className={CAMPO}>
          <option value="">—</option>
          {metodos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      {/* Un movimiento en Bs se escribe en bolívares y tasa: los dólares salen de dividir. */}
      {enBs ? (
        <div className="sm:col-span-2 max-w-sm">
          {/* key: al elegir o quitar el pedido cambia la tasa que corresponde. */}
          <MontoBs
            key={esEgreso ? 'libro' : enBsDePedido ? 'bcv' : 'directa'}
            tasaSugerida={esEgreso ? tasaLibroBs : enBsDePedido ? tasaBcvSugerida : tasaBsSugerida}
            etiquetaTasa={esEgreso ? 'Tasa del libro' : enBsDePedido ? 'Tasa BCV' : 'Tasa'}
            etiqueta={esEgreso ? 'Bs pagados' : undefined}
            unidad={enBsDePedido ? 'USD BCV' : 'USD'}
            requerido
          />
        </div>
      ) : (
        <label className={ETIQUETA}>
          Monto (USD)
          <input
            type="number" name="monto" min={0.01} step="0.01" inputMode="decimal" required
            value={monto} onChange={e => setMonto(e.target.value)}
            className={`${CAMPO} tabular-nums`}
          />
        </label>
      )}
      <label className={ETIQUETA}>
        Fecha
        <CampoFecha name="fecha" className={CAMPO} />
      </label>

      {/* Ingreso → de qué pedido (cliente). Egreso → de qué envío/proveedor. Nunca los
          dos juntos: un egreso no tiene cliente detrás, un ingreso no tiene proveedor. */}
      {esEgreso ? (
        <>
          <label className={ETIQUETA}>
            Caja (opcional)
            <select name="envioId" defaultValue="" className={CAMPO}>
              <option value="">—</option>
              {envios.map(e => (
                <option key={e.id} value={e.id}>
                  #{e.id} {e.nombre ?? ''}{e.estado !== 'confirmado' ? ` (${e.estado})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className={ETIQUETA}>
            Proveedor (opcional)
            <select name="supplierId" defaultValue="" className={CAMPO}>
              <option value="">—</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </>
      ) : (
        <label className={`${ETIQUETA} sm:col-span-2`}>
          Pedido (opcional)
          <select name="pedidoId" value={pedidoId} onChange={e => setPedidoId(e.target.value)} aria-describedby="mov-pedido-ayuda" className={CAMPO}>
            <option value="">—</option>
            {pedidos.map(p => <option key={p.id} value={p.id}>#{p.id} {p.clientName}</option>)}
          </select>
          <span id="mov-pedido-ayuda" className="font-normal text-gray-500 text-pretty">Si es de un pedido, se suma a lo cobrado de ese pedido.</span>
        </label>
      )}

      <label className={`${ETIQUETA} sm:col-span-2`}>
        Nota (opcional)
        <input type="text" name="descripcion" className={CAMPO} />
      </label>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center min-h-10 bg-blue-600 text-white px-5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-wait transition-colors"
        >
          {isPending ? 'Guardando…' : esEgreso ? 'Anotar egreso' : 'Anotar ingreso'}
        </button>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
    </form>
  )
}
