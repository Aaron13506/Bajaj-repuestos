import { db } from '@/lib/db'
import { getActiveSupplier } from '@/lib/suppliers'
import Sidebar from '@/components/Sidebar'

export default async function PagesLayout({ children }: { children: React.ReactNode }) {
  const [suppliers, activeSupplier] = await Promise.all([
    db.supplier.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    getActiveSupplier(),
  ])

  return (
    <div className="flex h-screen bg-gray-50 print:h-auto print:block">
      <Sidebar suppliers={suppliers} activeSupplierId={activeSupplier?.id ?? null} />
      <main className="flex-1 overflow-auto print:overflow-visible">
        <div className="p-8 print:p-0">{children}</div>
      </main>
    </div>
  )
}
