import { db } from '@/lib/db'
import Link from 'next/link'

async function getStats() {
  const [totalProducts, lowStock] = await Promise.all([
    db.product.count(),
    db.product.count({ where: { stock: { lt: 5 } } }),
  ])

  const agg = await db.product.aggregate({ _sum: { price: true } })
  const totalValue = parseFloat((agg._sum.price ?? 0).toString())

  const recentProducts = await db.product.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  const lowStockProducts = await db.product.findMany({
    where: { stock: { lt: 5 } },
    orderBy: { stock: 'asc' },
    take: 5,
  })

  return { totalProducts, lowStock, totalValue, recentProducts, lowStockProducts }
}

export default async function DashboardPage() {
  const stats = await getStats()

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Panel de Control</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <StatCard title="Total Productos" value={stats.totalProducts} color="blue" />
        <StatCard
          title="Stock Bajo"
          value={stats.lowStock}
          color={stats.lowStock > 0 ? 'red' : 'green'}
          description="menos de 5 unidades"
        />
        <StatCard title="Valor Inventario" value={`$${stats.totalValue.toFixed(2)}`} color="purple" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {stats.lowStock > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-red-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-gray-900">Alerta: Stock Bajo</h2>
              <Link href="/products?lowStock=1" className="text-sm text-blue-600 hover:underline">Ver todos</Link>
            </div>
            <div className="space-y-3">
              {stats.lowStockProducts.map((p) => (
                <div key={p.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{p.nameEs}</p>
                    <p className="text-xs text-gray-500 font-mono">{p.bajajCode ?? '—'}</p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${p.stock === 0 ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {p.stock} uds.
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Productos Recientes</h2>
            <Link href="/products" className="text-sm text-blue-600 hover:underline">Ver todos</Link>
          </div>
          {stats.recentProducts.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Sin productos aún</p>
          ) : (
            <div className="space-y-3">
              {stats.recentProducts.map((p) => (
                <div key={p.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{p.nameEs}</p>
                    <p className="text-xs text-gray-500">{p.compatibleModels ?? <span className="italic">Sin modelo</span>}</p>
                  </div>
                  <span className="text-sm font-medium text-gray-700">${parseFloat(p.price.toString()).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ title, value, color, description }: {
  title: string
  value: string | number
  color: 'blue' | 'green' | 'yellow' | 'red' | 'purple'
  description?: string
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    yellow: 'bg-yellow-50 text-yellow-700',
    red: 'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
  }
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className={`inline-flex items-center justify-center w-10 h-10 rounded-lg mb-4 ${colors[color]}`}>
        <span className="text-lg font-bold">#</span>
      </div>
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {description && <p className="text-xs text-gray-400 mt-1">{description}</p>}
    </div>
  )
}
