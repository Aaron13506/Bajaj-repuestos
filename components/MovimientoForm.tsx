'use client'

import { useState, useTransition } from 'react'

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
  action: (formData: FormData) => Promise<void>
  categoriasIngreso: Categoria[]
  categoriasEgreso: Categoria[]
  metodosIngreso: readonly string[]
  metodosEgreso: readonly string[]
  pedidos: Pedido[]
  envios: Envio[]
  suppliers: Supplier[]
}

// Ingreso y egreso son dos formularios distintos que comparten fecha/monto/nota: un
// ingreso cobra en efectivo/Bs/cripto y se liga a un PEDIDO (el cliente); un egreso se
// paga por giro/tarjeta/cripto y se liga a un ENVÍO/PROVEEDOR — nunca a un pedido. Antes
// se mostraban los seis campos siempre, y "método de pago" ofrecía "Transferencia Bs"
// para pagarle a un proveedor en India, lo que no corresponde a ningún medio real.
export default function MovimientoForm({
  action,
  categoriasIngreso,
  categoriasEgreso,
  metodosIngreso,
  metodosEgreso,
  pedidos,
  envios,
  suppliers,
}: Props) {
  const [categoria, setCategoria] = useState(categoriasIngreso[0]?.value ?? '')
  const [isPending, startTransition] = useTransition()
  const today = new Date().toISOString().slice(0, 10)

  const esEgreso = categoriasEgreso.some(c => c.value === categoria)
  const metodos = esEgreso ? metodosEgreso : metodosIngreso

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      await action(fd)
      ;(e.currentTarget as HTMLFormElement).reset()
      setCategoria(categoriasIngreso[0]?.value ?? '')
    })
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8 flex flex-wrap items-end gap-3"
    >
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Categoría</label>
        <select
          name="categoria"
          value={categoria}
          onChange={e => setCategoria(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <optgroup label="Ingresos">
            {categoriasIngreso.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </optgroup>
          <optgroup label="Egresos">
            {categoriasEgreso.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Monto (USD)</label>
        <input
          type="number" name="monto" min={0.01} step="0.01" required
          className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Fecha</label>
        <input
          type="date" name="fecha" defaultValue={today}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Método de pago</label>
        <select key={esEgreso ? 'egreso' : 'ingreso'} name="metodoPago" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          <option value="">—</option>
          {metodos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Ingreso → de qué pedido (cliente). Egreso → de qué envío/proveedor. Nunca los
          dos juntos: un egreso no tiene cliente detrás, un ingreso no tiene proveedor. */}
      {esEgreso ? (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1">Envío (opcional)</label>
            <select name="envioId" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="">—</option>
              {envios.map(e => (
                <option key={e.id} value={e.id}>
                  #{e.id} {e.nombre ?? ''}{e.estado !== 'confirmado' ? ` (${e.estado})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1">Proveedor (opcional)</label>
            <select name="supplierId" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="">—</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Pedido (opcional)</label>
          <select name="pedidoId" defaultValue="" className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="">—</option>
            {pedidos.map(p => (
              <option key={p.id} value={p.id}>#{p.id} {p.clientName}</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 min-w-[180px]">
        <label className="block text-sm font-medium text-gray-800 mb-1">Nota (opcional)</label>
        <input
          type="text" name="descripcion"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
      >
        {isPending ? 'Guardando…' : '+ Movimiento'}
      </button>
    </form>
  )
}
