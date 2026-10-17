import DetallePedido from '../../presupuestos/[id]/detalle'

export default function VentaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <DetallePedido params={params} ruta="ventas" />
}
