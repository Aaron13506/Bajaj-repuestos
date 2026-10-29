import { db } from '@/lib/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { codigoContiene } from '@/lib/alt-sku'

export const metadata = { title: 'Buscar' }

const LIMITE = 15

// Búsqueda global (el campo de la barra lateral, Ctrl+K): pedidos, clientes, piezas y cajas
// en una sola tanda. "#123" o "123" que es un pedido va directo a él.
export default async function BuscarPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q?.trim() ?? ''
  const num = /^#?\d+$/.test(q) ? parseInt(q.replace('#', '')) : null
  if (num != null && q.startsWith('#')) {
    const p = await db.pedido.findUnique({ where: { id: num }, select: { id: true, tipo: true } })
    if (p) redirect(p.tipo === 'venta' ? `/ventas/${p.id}` : `/presupuestos/${p.id}`)
  }

  const texto = { contains: q, mode: 'insensitive' as const }
  const [pedidos, clientes, productos, envios] = q
    ? await Promise.all([
        db.pedido.findMany({
          where: { OR: [...(num != null ? [{ id: num }] : []), { clientName: texto }, { notas: texto }] },
          select: { id: true, clientName: true, tipo: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: LIMITE,
        }),
        db.cliente.findMany({
          where: { OR: [{ nombre: texto }, { telefono: { contains: q } }] },
          select: { id: true, nombre: true, telefono: true },
          orderBy: { nombre: 'asc' },
          take: LIMITE,
        }),
        db.product.findMany({
          where: { OR: [{ nameEs: texto }, { nameEn: texto }, ...codigoContiene(q)] },
          select: { id: true, nameEs: true, bajajCode: true },
          orderBy: { nameEs: 'asc' },
          take: LIMITE,
        }),
        db.envio.findMany({
          where: { OR: [...(num != null ? [{ id: num }] : []), { nombre: texto }, { trackings: { some: { numero: texto } } }] },
          select: { id: true, nombre: true, trackings: { select: { numero: true }, orderBy: { id: 'asc' } } },
          orderBy: { createdAt: 'desc' },
          take: LIMITE,
        }),
      ])
    : [[], [], [], []]

  const total = pedidos.length + clientes.length + productos.length + envios.length

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Buscar</h1>
      <form className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Cliente, #pedido, SKU, pieza, caja o guía…"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </form>

      {q && total === 0 && <p className="text-sm text-gray-400">Nada coincide con &quot;{q}&quot;.</p>}

      <div className="space-y-6">
        <Grupo titulo="Pedidos y presupuestos" n={pedidos.length}>
          {pedidos.map(p => (
            <Fila
              key={p.id}
              href={p.tipo === 'venta' ? `/ventas/${p.id}` : `/presupuestos/${p.id}`}
              izq={`#${p.id} ${p.clientName}`}
              der={p.tipo === 'venta' ? 'venta' : p.tipo === 'propio' ? 'stock propio' : p.status}
            />
          ))}
        </Grupo>
        <Grupo titulo="Clientes" n={clientes.length}>
          {clientes.map(c => <Fila key={c.id} href={`/clientes/${c.id}`} izq={c.nombre} der={c.telefono ?? ''} />)}
        </Grupo>
        <Grupo titulo="Piezas" n={productos.length}>
          {productos.map(p => <Fila key={p.id} href={`/products/${p.id}`} izq={p.nameEs} der={p.bajajCode ?? ''} />)}
        </Grupo>
        <Grupo titulo="Cajas" n={envios.length}>
          {envios.map(e => <Fila key={e.id} href={`/envios/${e.id}`} izq={e.nombre ?? `Caja #${e.id}`} der={e.trackings.map(t => t.numero).join(', ')} />)}
        </Grupo>
      </div>
    </div>
  )
}

function Grupo({ titulo, n, children }: { titulo: string; n: number; children: React.ReactNode }) {
  if (n === 0) return null
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        {titulo} ({n}{n === LIMITE ? '+' : ''})
      </h2>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  )
}

function Fila({ href, izq, der }: { href: string; izq: string; der: string }) {
  return (
    <Link href={href} className="flex items-center justify-between py-2 hover:bg-gray-50 -mx-2 px-2 rounded">
      <span className="text-sm text-gray-800 truncate">{izq}</span>
      <span className="text-xs text-gray-400 font-mono shrink-0 ml-3">{der}</span>
    </Link>
  )
}
