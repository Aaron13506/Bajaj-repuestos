import Link from 'next/link'
import { db } from '@/lib/db'
import MarcarDescontinuados from '@/components/MarcarDescontinuados'

// Piezas que Bajaj dejó de fabricar. No se pueden comprar a NINGÚN proveedor, así que la
// app las bloquea en el armador de embarques y en el de presupuestos: el precio que
// pudieran tener cargado describe una compra que ya no existe.

export const dynamic = 'force-dynamic'

const fecha = (d: Date) => d.toISOString().slice(0, 10)

export default async function DescontinuadosPage() {
  const [marcadas, total] = await Promise.all([
    db.product.findMany({
      where: { discontinuedAt: { not: null } },
      select: { id: true, bajajCode: true, nameEs: true, compatibleModels: true, stock: true, discontinuedAt: true },
      orderBy: [{ discontinuedAt: 'desc' }, { nameEs: 'asc' }],
    }),
    db.product.count(),
  ])

  const conStock = marcadas.filter(p => p.stock > 0)

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Link href="/products" className="text-gray-400 hover:text-gray-600 text-sm">Productos</Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-2xl font-bold text-gray-900">Piezas descontinuadas</h1>
        </div>
        <p className="text-sm text-gray-500">
          Bajaj dejó de fabricarlas. No es que un proveedor no las tenga: no las consigue ninguno, así que la app
          no te deja meterlas en un embarque ni en un presupuesto. El scrape de 99rpm las marca solo cuando la
          página las rotula; acá las cargás vos cuando el dato llega antes.
        </p>
      </div>

      <MarcarDescontinuados />

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">
            Marcadas hoy: {marcadas.length}
            <span className="font-normal text-gray-400"> de {total} productos</span>
          </h2>
          {conStock.length > 0 && (
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800"
              title="Descontinuada no es lo mismo que agotada: lo que ya tenés se puede vender, lo que no podés es reponerlo"
            >
              {conStock.length} con stock todavía
            </span>
          )}
        </div>

        {marcadas.length === 0 ? (
          <p className="p-10 text-center text-gray-400 text-sm">
            Ninguna pieza marcada. Pegá códigos arriba, o corré el scrape de 99rpm para que las traiga rotuladas.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-semibold">Pieza</th>
                <th className="text-left px-3 py-3 font-semibold">Motos</th>
                <th className="text-right px-3 py-3 font-semibold">Stock</th>
                <th className="text-right px-4 py-3 font-semibold">Marcada</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {marcadas.map(p => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/products/${p.id}`} className="text-gray-900 hover:text-blue-600">{p.nameEs}</Link>
                    {p.bajajCode && <span className="ml-2 font-mono text-xs text-gray-400">{p.bajajCode}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-500 max-w-xs truncate" title={p.compatibleModels ?? ''}>
                    {p.compatibleModels ?? '—'}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-mono ${p.stock > 0 ? 'text-amber-700 font-semibold' : 'text-gray-400'}`}>
                    {p.stock}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-400">
                    {p.discontinuedAt ? fecha(p.discontinuedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
