import { db } from '@/lib/db'
import VentaDirectaForm from '@/components/VentaDirectaForm'
import { registrarVenta } from '../actions'
import { escalonBcvVigente } from '@/lib/calc'
import { toConfigMap, num } from '@/lib/config'
import { METODOS_PAGO_INGRESO } from '@/lib/pagos'
import { nombreEnsamble } from '@/lib/linea-pedido'
import { toModelIds, type MotoModelId } from '@/lib/modelo'

export default async function NuevaVentaPage() {
  const enStock = { product: { stock: { gt: 0 } } }
  const [clientes, cfgRows, ensambles, sueltas] = await Promise.all([
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
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Venta del depósito</h1>
        <p className="text-sm text-gray-500 mt-1">
          Para vender lo que ya tenés: sin presupuesto ni caja. Solo aparecen las motos, ensambles y piezas que
          tenés en el depósito. Baja el stock, se queda con lo que costó cada pieza para saber cuánto ganaste, y
          queda registrado a nombre del cliente. Lo que no tenés se cotiza como presupuesto.
        </p>
      </div>
      <VentaDirectaForm
        action={registrarVenta}
        clientes={clientes}
        ensambles={ensamblesCliente}
        motos={[...motos]}
        metodos={METODOS_PAGO_INGRESO}
        escalon={escalonBcvVigente(cfg)}
        tasaBcv={num(cfg, 'bcv_usd_rate', 0)}
        tasaDirecta={num(cfg, 'bsd_usd_rate', 0)}
      />
    </div>
  )
}
