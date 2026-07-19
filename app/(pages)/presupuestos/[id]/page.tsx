import { db } from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import DeleteButton from '@/components/DeleteButton'
import PrintButton from '@/components/PrintButton'
import AprobarPedidoForm from '@/components/AprobarPedidoForm'
import { deletePresupuesto, aprobarPedido } from '../actions'
import { type BundlePiece, groupBundlePieces } from '@/lib/bundle'
import { getTerminos } from '@/lib/terminos'
import { METODOS_PAGO } from '@/lib/pagos'

export default async function PresupuestoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id)
  if (isNaN(id)) notFound()

  const [presupuesto, bsdRow] = await Promise.all([
    db.pedido.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, nameEs: true, bajajCode: true, description: true, imageUrl: true },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    }),
    db.config.findUnique({ where: { key: 'bsd_usd_rate' } }),
  ])

  if (!presupuesto) notFound()

  const isPropio = presupuesto.tipo === 'propio'
  const isPresupuesto = presupuesto.status === 'presupuesto'
  const terminos = await getTerminos(presupuesto.status)
  const total = presupuesto.items.reduce(
    (sum, item) => sum + parseFloat(item.salePrice.toString()) * item.quantity,
    0
  )

  const bsdRate = bsdRow ? parseFloat(bsdRow.value) : NaN
  const totalBsd = Number.isNaN(bsdRate) ? null : total * bsdRate
  const deposit = total * 0.5

  // Adelanto ya registrado (pedido de cliente confirmado)
  const depositUsd = presupuesto.depositUsd != null ? parseFloat(presupuesto.depositUsd.toString()) : null
  const saldoUsd = depositUsd != null ? total - depositUsd : null
  const depositDateStr = presupuesto.depositAt
    ? new Date(presupuesto.depositAt).toISOString().slice(0, 10)
    : null

  const created = new Date(presupuesto.createdAt)
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })
  const fecha = fmtDate(created)
  const validez = fmtDate(new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000))
  const numero = `N.º ${String(presupuesto.id).padStart(4, '0')}`
  const docLabel = isPresupuesto ? 'Presupuesto' : 'Pedido'

  return (
    <div className="max-w-3xl">

      {/* Screen-only header */}
      <div className="flex items-start justify-between gap-4 mb-6 print:hidden">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/presupuestos" className="text-gray-400 hover:text-gray-600 text-sm">
              Presupuestos
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">#{presupuesto.id}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{presupuesto.clientName}</h1>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isPropio
                ? 'bg-blue-100 text-blue-700'
                : isPresupuesto
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-green-100 text-green-700'
            }`}>
              {isPropio ? 'Stock propio' : isPresupuesto ? 'Presupuesto' : 'Pedido confirmado'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {!isPropio && isPresupuesto && (
            <>
              <div className="relative">
                <AprobarPedidoForm
                  action={aprobarPedido.bind(null, id)}
                  methods={METODOS_PAGO}
                  suggestedDeposit={deposit}
                />
              </div>
              <Link
                href={`/presupuestos/${id}/edit`}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Editar
              </Link>
            </>
          )}
          {!isPropio && !isPresupuesto && (
            <div className="relative">
              <AprobarPedidoForm
                mode="editar"
                action={aprobarPedido.bind(null, id)}
                methods={METODOS_PAGO}
                suggestedDeposit={deposit}
                initialDeposit={depositUsd}
                initialMethod={presupuesto.paymentMethod}
                initialDate={depositDateStr}
              />
            </div>
          )}
          {isPropio && (
            <Link
              href={`/presupuestos/${id}/edit`}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Editar
            </Link>
          )}
          <Link
            href={`/presupuestos/${id}/proveedor`}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Para proveedor
          </Link>
          <PrintButton />
          <DeleteButton
            action={deletePresupuesto.bind(null, id)}
            confirmMessage={`¿Eliminar ${isPropio ? 'stock propio' : isPresupuesto ? 'presupuesto' : 'pedido'} de "${presupuesto.clientName}"?`}
          />
        </div>
      </div>

      {/* Print-only letterhead */}
      <div className="hidden print:block mb-5">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Bajaj Repuestos</h1>
            <p className="text-[10px] text-gray-500">Repuestos Pulsar por encargo · India → Venezuela</p>
          </div>
          <div className="text-right text-[11px] leading-relaxed">
            <p className="font-semibold uppercase tracking-wide text-gray-800">{docLabel} {numero}</p>
            <p className="text-gray-600">Fecha: {fecha}</p>
            {isPresupuesto && <p className="text-gray-600">Válido hasta: {validez}</p>}
          </div>
        </div>
        <hr className="mt-3 border-gray-300" />
      </div>

      {/* Client info */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4 print:p-0 print:mb-3 print:border-0 print:shadow-none">
        <div className="flex justify-between text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Cliente</p>
            <p className="font-semibold text-gray-900 text-base">{presupuesto.clientName}</p>
          </div>
          <div className="text-right print:hidden">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Fecha</p>
            <p className="text-gray-700">{fecha}</p>
            {isPresupuesto && (
              <p className="text-xs text-gray-400 mt-1">Válido hasta {validez}</p>
            )}
          </div>
        </div>
        {presupuesto.notas && (
          <div className="mt-4 pt-4 border-t border-gray-100 print:mt-3 print:pt-3">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Notas</p>
            <p className="text-sm text-gray-700">{presupuesto.notas}</p>
          </div>
        )}
      </div>

      {/* Items table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4 print:border-0 print:shadow-none print:rounded-none">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 print:bg-transparent">
              <th className="w-16 px-3 py-3" />
              <th className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Pieza
              </th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-20">
                Cant.
              </th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                P. Unit.
              </th>
              <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                Subtotal
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {presupuesto.items.map(item => {
              const unitPrice = parseFloat(item.salePrice.toString())
              const subtotal = unitPrice * item.quantity
              const bundlePieces = (item.bundleItems as BundlePiece[] | null) ?? []
              return (
                <tr key={item.id} className="hover:bg-gray-50 print:hover:bg-transparent break-inside-avoid">
                  <td className="px-3 py-3 align-top">
                    {item.product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.product.imageUrl}
                        alt={item.product.nameEs}
                        loading="lazy"
                        className="w-12 h-12 object-contain rounded-lg border border-gray-100 bg-white [print-color-adjust:exact]"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg border border-dashed border-gray-200 bg-gray-50 print:bg-transparent" />
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="text-sm font-medium text-gray-900">{item.product.nameEs}</p>
                    {item.product.bajajCode && (
                      <p className="text-xs font-mono text-gray-400">{item.product.bajajCode}</p>
                    )}
                    {bundlePieces.length > 0 && (
                      <div className="mt-1.5 ml-1 pl-3 border-l-2 border-gray-100 space-y-1.5">
                        {groupBundlePieces(bundlePieces).map(([groupName, pieces]) => (
                          <div key={groupName}>
                            {groupName !== '—' && (
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                {groupName}
                              </p>
                            )}
                            <ul className="space-y-0.5">
                              {pieces.map((p, i) => (
                                <li key={i} className="text-xs text-gray-500">
                                  {p.quantity}× {p.nameEs}
                                  {p.bajajCode && (
                                    <span className="ml-1.5 font-mono text-gray-300">{p.bajajCode}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-gray-700 align-top">{item.quantity}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono text-gray-700 align-top">
                    ${unitPrice.toFixed(2)}
                  </td>
                  <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-gray-900 align-top">
                    ${subtotal.toFixed(2)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Totales */}
      <div className="flex justify-end mb-4 break-inside-avoid">
        <div className="w-full sm:w-80 space-y-1.5">
          <div className="flex justify-between items-baseline border-t-2 border-gray-200 pt-3">
            <span className="font-bold text-gray-900">Total USD</span>
            <span className="font-bold text-2xl font-mono text-blue-700">${total.toFixed(2)}</span>
          </div>
          {totalBsd != null && (
            <div className="flex justify-between text-sm text-gray-500">
              <span>Referencia en bolívares</span>
              <span className="font-mono">Bs {totalBsd.toLocaleString('es-VE', { maximumFractionDigits: 0 })}</span>
            </div>
          )}
          {isPresupuesto && (
            <div className="flex justify-between items-center bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 mt-2 [print-color-adjust:exact]">
              <span className="text-sm font-semibold text-yellow-800">Abono 50% para confirmar</span>
              <span className="font-bold font-mono text-yellow-900">${deposit.toFixed(2)}</span>
            </div>
          )}
          {!isPropio && !isPresupuesto && depositUsd != null && (
            <div className="mt-2 space-y-1.5">
              <div className="flex justify-between items-center bg-green-50 border border-green-200 rounded-lg px-3 py-2 [print-color-adjust:exact]">
                <span className="text-sm font-semibold text-green-800">
                  Adelanto recibido
                  {presupuesto.paymentMethod && (
                    <span className="font-normal text-green-600"> · {presupuesto.paymentMethod}</span>
                  )}
                </span>
                <span className="font-bold font-mono text-green-900">${depositUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center px-3">
                <span className="text-sm font-semibold text-gray-700">Saldo pendiente</span>
                <span className="font-bold font-mono text-gray-900">${(saldoUsd ?? 0).toFixed(2)}</span>
              </div>
              {presupuesto.depositAt && (
                <p className="text-xs text-gray-400 px-3 print:hidden">
                  Adelanto del {new Date(presupuesto.depositAt).toLocaleDateString('es-VE', { day: '2-digit', month: 'long', year: 'numeric' })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Terms & conditions (print only) */}
      {terminos && (
        <div className="hidden print:block mt-6 pt-3 border-t border-gray-200 break-inside-avoid">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
            Términos y condiciones
          </p>
          <p className="text-[10px] leading-relaxed text-gray-600 whitespace-pre-line">
            {terminos}
          </p>
        </div>
      )}

      {/* Print footer */}
      <p className="hidden print:block text-xs text-gray-400 text-center mt-4">
        Bajaj Repuestos · Precios en dólares (USD)
        {totalBsd != null && ' · referencia BsD a la tasa del día'} · {fecha}
      </p>
    </div>
  )
}
