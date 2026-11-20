import Link from 'next/link'
import { db } from '@/lib/db'
import FormConResultado from '@/components/FormConResultado'
import PendingButton from '@/components/PendingButton'
import QrEnlace from '@/components/QrEnlace'
import { sugerenciasDeConteo } from '@/lib/conteo-inventario-db'
import { DIAS_VENCE_CONTEO } from '@/lib/conteo-inventario'
import { abrirEstante, abrirLista } from '@/app/(escaneo)/escanear/inventario/actions'

export const metadata = { title: 'Conteo cíclico' }

// Conteo cíclico (docs/plan-inventario/05-ubicaciones-conteo.md): en vez de un inventario completo,
// un pedazo cada vez. Acá se elige qué contar (por estante o la lista sugerida); se cuenta en
// /escanear/inventario/[id], que también abre en la laptop.
const MARCADAS = 20

export default async function ConteoPage() {
  const [sugeridas, abiertos, cerrados] = await Promise.all([
    sugerenciasDeConteo(),
    db.conteoInventario.findMany({
      where: { cerradoAt: null }, orderBy: { abiertoAt: 'desc' },
      select: { id: true, ubicacion: true, abiertoAt: true, lineas: { select: { contado: true } } },
    }),
    db.conteoInventario.findMany({
      where: { cerradoAt: { not: null } }, orderBy: { cerradoAt: 'desc' }, take: 10,
      select: { id: true, ubicacion: true, cerradoAt: true, notas: true, _count: { select: { lineas: true } } },
    }),
  ])
  const base = process.env.APP_URL?.trim().replace(/\/+$/, '') || null
  const fecha = (d: Date) => d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', timeZone: 'America/Caracas' })
  const nombre = (c: { id: number; ubicacion: string | null }) => (c.ubicacion ? `Estante ${c.ubicacion}` : `Lista #${c.id}`)

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/inventario" className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline">← Inventario</Link>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Conteo cíclico</h1>
        <p className="text-sm text-gray-500 mt-1 text-pretty">
          Contá unos pocos estantes por semana y todo el depósito se cuenta solo. Cada diferencia queda como un
          movimiento «Conteo» en el kardex de la pieza. <Link href="/inventario/etiquetas" className="text-blue-700 hover:underline">Imprimir etiquetas de estante</Link>
        </p>
      </div>

      <section aria-labelledby="estante" className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
        <h2 id="estante" className="font-semibold text-gray-900">Contar un estante</h2>
        <FormConResultado action={abrirEstante} className="flex flex-wrap items-center gap-2">
          <input name="estante" required autoComplete="off" placeholder="A-3" aria-label="Estante" className="h-9 w-32 rounded-lg border border-gray-300 px-3 font-mono uppercase" />
          <PendingButton pendingLabel="Abriendo…" className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50">Abrir conteo</PendingButton>
        </FormConResultado>
        <p className="text-xs text-gray-600">Carga las piezas con esa ubicación. Desde el teléfono: modo Inventario y escaneá la etiqueta del estante.</p>
      </section>

      {abiertos.length > 0 && (
        <section aria-labelledby="abiertos" className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <h2 id="abiertos" className="font-semibold text-gray-900">Contándose</h2>
          {abiertos.map(c => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 first:border-0 first:pt-0">
              <div>
                <Link href={`/escanear/inventario/${c.id}`} className="font-medium text-blue-700 hover:underline">{nombre(c)}</Link>
                <p className="text-sm text-gray-600">Abierto el {fecha(c.abiertoAt)} · {c.lineas.filter(l => l.contado != null).length} de {c.lineas.length} contadas</p>
              </div>
              <QrEnlace ruta={`/escanear/inventario/${c.id}`} base={base} texto="Escaneá con el teléfono para contar ahí." />
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="sugeridas" className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div>
          <h2 id="sugeridas" className="font-semibold text-gray-900">Qué contar</h2>
          <p className="text-sm text-gray-600 text-pretty">
            Primero lo que tuvo un ajuste a mano o se movió desde su último conteo (lo que más se mueve es lo que más se
            desajusta); después lo que tiene stock y nunca se contó o hace más de {DIAS_VENCE_CONTEO} días.
          </p>
        </div>
        {sugeridas.length === 0 ? <p className="text-sm text-gray-600">Nada pendiente: todo lo que tiene stock está contado.</p> : (
          <FormConResultado action={abrirLista} className="space-y-3">
            <ul className="divide-y divide-gray-100">
              {sugeridas.map((p, i) => (
                <li key={p.id}>
                  <label className="flex items-center gap-3 py-2 text-sm">
                    <input type="checkbox" name="pieza" value={p.id} defaultChecked={i < MARCADAS} className="size-4" />
                    <span className="min-w-0 flex-1">
                      <span className="text-gray-900 break-words">{p.nameEs}</span>{' '}
                      <span className="font-mono text-xs text-gray-500">{p.bajajCode ?? 'sin SKU'}</span>
                      <span className="block text-xs text-gray-600">{p.motivo}</span>
                    </span>
                    <span className="w-16 text-right font-mono text-xs text-gray-600">{p.ubicacion ?? 'sin ubic.'}</span>
                    <span className="w-14 text-right tabular-nums text-gray-900">{p.stock} u.</span>
                  </label>
                </li>
              ))}
            </ul>
            <PendingButton pendingLabel="Abriendo…" className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50">Contar las marcadas</PendingButton>
          </FormConResultado>
        )}
      </section>

      {cerrados.length > 0 && (
        <section aria-labelledby="cerrados" className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
          <h2 id="cerrados" className="font-semibold text-gray-900">Últimos conteos</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {cerrados.map(c => (
              <li key={c.id} className="py-2 flex flex-wrap gap-x-3">
                <Link href={`/escanear/inventario/${c.id}`} className="font-medium text-blue-700 hover:underline">{nombre(c)}</Link>
                <span className="text-gray-600">{fecha(c.cerradoAt!)} · {c._count.lineas} piezas</span>
                {c.notas && <span className="text-gray-700">{c.notas}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
