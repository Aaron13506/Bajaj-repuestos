import { db } from '@/lib/db'
import Link from 'next/link'
import VentaDirectaForm from '@/components/VentaDirectaForm'
import { registrarVenta, piezasEnStock } from '../actions'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap, num } from '@/lib/config'
import { METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toModelIds, type MotoModelId } from '@/lib/modelo'

export const metadata = { title: 'Nueva venta' }

// ?pieza=ID: llega desde «Vender» del inicio y abre la venta con esa pieza en el carrito.
// ?piezas=ID:CANT,ID:CANT: el carrito del modo Vender del teléfono (/escanear/venta).
export default async function NuevaVentaPage({ searchParams }: { searchParams: Promise<{ pieza?: string; piezas?: string }> }) {
  const { pieza, piezas } = await searchParams
  const pedidas = new Map<number, number>(pieza ? [[Number(pieza), 1]] : [])
  for (const par of (piezas ?? '').split(',')) {
    const [id, cant] = par.split(':').map(Number)
    if (Number.isInteger(id) && Number.isInteger(cant) && cant > 0) pedidas.set(id, cant)
  }
  const enStock = { product: { stock: { gt: 0 } } }
  const [clientes, cfgRows, ensambles, sueltas, inicial] = await Promise.all([
    db.cliente.findMany({ orderBy: { nombre: 'asc' }, select: { id: true, nombre: true, telefono: true } }),
    db.config.findMany(),
    // Solo los ensambles que tienen al menos una pieza en el depósito: el resto no se puede
    // vender, y listarlos solo esconde los que sí.
    db.ensamble.findMany({
      where: { componentes: { some: enStock } },
      select: {
        id: true, nameEs: true, nameEn: true, imageUrl: true, compatibleModels: true,
        componentes: { where: enStock, select: { product: { select: { id: true, nameEs: true, stock: true } } } },
      },
      orderBy: [{ nameEs: 'asc' }, { compatibleModels: 'asc' }],
    }),
    db.product.findMany({ where: { stock: { gt: 0 } }, select: { compatibleModels: true } }),
    piezasEnStock([...pedidas.keys()]),
  ])
  const cfg = toConfigMap(cfgRows)

  const ensamblesCliente = ensambles.map(a => ({
    id: a.id,
    nameEs: nombreEnsamble(a),
    imageUrl: a.imageUrl,
    models: toModelIds(a.compatibleModels),
    piezas: a.componentes.map(c => c.product),
  }))

  // Las motos de las que tengo algo: las de los ensambles con stock y las de las piezas con
  // stock. Una moto sin nada en el depósito no es una opción del filtro.
  const motos = new Set<MotoModelId>()
  for (const a of ensamblesCliente) a.models.forEach(m => motos.add(m))
  for (const p of sueltas) toModelIds(p.compatibleModels).forEach(m => motos.add(m))

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <Link href="/ventas" className="inline-flex items-center min-h-8 text-sm text-blue-700 hover:underline">← Ventas</Link>
        <h1 className="text-2xl font-bold text-gray-900 text-balance">Nueva venta del depósito</h1>
      </div>
      <VentaDirectaForm
        action={registrarVenta}
        clientes={clientes}
        ensambles={ensamblesCliente}
        motos={[...motos]}
        inicial={inicial.map(p => ({ pieza: p, cantidad: pedidas.get(p.id) ?? 1 }))}
        metodos={METODOS_PAGO_INGRESO}
        escalon={escalonBcvVigente(cfg)}
        tasaBcv={num(cfg, 'bcv_usd_rate', 0)}
        tasaDirecta={num(cfg, 'bsd_usd_rate', 0)}
      />
    </div>
  )
}
