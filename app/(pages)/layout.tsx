import { db } from '@/lib/db'
import { getActiveSupplier } from '@/lib/suppliers'
import Sidebar from '@/components/Sidebar'

export default async function PagesLayout({ children }: { children: React.ReactNode }) {
  const [suppliers, activeSupplier] = await Promise.all([
    db.supplier.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    getActiveSupplier(),
  ])

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar suppliers={suppliers} activeSupplierId={activeSupplier?.id ?? null} />
      <main className="flex-1 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  )
}
