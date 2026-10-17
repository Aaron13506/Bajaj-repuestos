import DetallePedido from './detalle'

export default function PresupuestoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <DetallePedido params={params} ruta="presupuestos" />
}
