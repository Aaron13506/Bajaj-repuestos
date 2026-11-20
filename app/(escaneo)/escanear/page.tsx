import Link from 'next/link'

export const metadata = { title: 'Escanear' }

// Elegir modo. Inventario se suma con las fases que los habilitan
// (docs/plan-inventario/06-telefono.md).
export default function EscanearPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Escanear</h1>
        <Link href="/" className="flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-blue-700">
          Ir al panel
        </Link>
      </div>
      <Link
        href="/escanear/recepcion"
        className="block rounded-xl border border-gray-200 bg-white p-5 shadow-sm active:bg-gray-100"
      >
        <span className="block text-lg font-semibold text-gray-900">Recibir</span>
        <span className="mt-1 block text-sm text-gray-600">
          Contá lo que llegó en una caja: cada etiqueta suma en su fila.
        </span>
      </Link>
      <Link
        href="/escanear/consultar"
        className="block rounded-xl border border-gray-200 bg-white p-5 shadow-sm active:bg-gray-100"
      >
        <span className="block text-lg font-semibold text-gray-900">Consultar</span>
        <span className="mt-1 block text-sm text-gray-600">
          Escaneá o escribí un código: stock, precio, medidas y en qué pedidos y cajas está.
        </span>
      </Link>
      <Link
        href="/escanear/venta"
        className="block rounded-xl border border-gray-200 bg-white p-5 shadow-sm active:bg-gray-100"
      >
        <span className="block text-lg font-semibold text-gray-900">Vender</span>
        <span className="mt-1 block text-sm text-gray-600">
          Escaneá lo que se lleva el cliente y cobralo en la venta del depósito.
        </span>
      </Link>
      <Link
        href="/escanear/medir"
        className="block rounded-xl border border-gray-200 bg-white p-5 shadow-sm active:bg-gray-100"
      >
        <span className="block text-lg font-semibold text-gray-900">Medir</span>
        <span className="mt-1 block text-sm text-gray-600">
          Escaneá una pieza y cargá su peso y medidas como llegó, en su caja o bolsa.
        </span>
      </Link>
    </div>
  )
}
