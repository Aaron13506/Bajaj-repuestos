import Sidebar from '@/components/Sidebar'

export default function PagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50 print:h-auto print:block">
      <Sidebar />
      <main className="flex-1 overflow-auto print:overflow-visible">
        <div className="p-8 print:p-0">{children}</div>
      </main>
    </div>
  )
}
