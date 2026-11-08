import { db } from '@/lib/db'
import Link from 'next/link'
import VentaDirectaForm from '@/components/VentaDirectaForm'
import { registrarVenta, piezaEnStock } from '../actions'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap, num } from '@/lib/config'
import { METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toModelIds, type MotoModelId } from '@/lib/modelo'

export const metadata = { title: 'Nueva venta' }

// ?pieza=ID: llega desde «Vender» del inicio y abre la venta con esa pieza en el carrito.
export default async function NuevaVentaPage({ searchParams }: { searchParams: Promise<{ pieza?: string }> }) {
  const { pieza } = await searchParams
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
    pieza ? piezaEnStock(Number(pieza)) : null,
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
        <p className="text-sm text-gray-500 mt-1 text-pretty">
          Solo aparece lo que tenés en stock. Al registrar baja el stock y queda a nombre del cliente con lo que
          ganaste. Lo que no tenés se cotiza como <Link href="/presupuestos/new" className="text-blue-700 hover:underline">presupuesto</Link>.
        </p>
      </div>
      <VentaDirectaForm
        action={registrarVenta}
        clientes={clientes}
        ensambles={ensamblesCliente}
        motos={[...motos]}
        inicial={inicial}
        metodos={METODOS_PAGO_INGRESO}
        escalon={escalonBcvVigente(cfg)}
        tasaBcv={num(cfg, 'bcv_usd_rate', 0)}
        tasaDirecta={num(cfg, 'bsd_usd_rate', 0)}
      />
    </div>
  )
}
