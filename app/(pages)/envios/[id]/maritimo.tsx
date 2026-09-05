import Link from 'next/link'
import { db } from '@/lib/db'
import DeleteButton from '@/components/DeleteButton'
import EmbarqueMaritimo, { type LineaEmbarque, type AssemblyOption } from '@/components/EmbarqueMaritimo'
import MedidasIA, { type GrupoMedidas, type PiezaMedible } from '@/components/MedidasIA'
import CompararProveedores from '@/components/CompararProveedores'
import SelectorProveedorEmbarque from '@/components/SelectorProveedorEmbarque'
import CopiarJson from '@/components/CopiarJson'
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { embarqueAJson } from '@/lib/export-embarque'
import { compararProveedores } from '@/lib/comparar-proveedores'
import { resumirCbm, costoRealPorM3, costoEmbarque, CBM_MAX_KG_PER_M3 } from '@/lib/cbm'
import { cbmParams, type ConfigMap } from '@/lib/calc'
import { getSupplierPriceMap } from '@/lib/suppliers'
import { cumpleMoq } from '@/lib/moq'
import { alternosDe } from '@/lib/alt-sku'
import { sortModels } from '@/lib/catalog'
import { modelosDistintos, parseModelos } from '@/lib/modelos'
import { deleteEnvio, saveCostosProveedor } from '../actions'
import { cerrarEmbarque, reabrirEmbarque } from '../linea-actions'
import { toConfigMap } from '@/lib/config'

const usd = (n: number) => `$${n.toFixed(2)}`
// Con 3 decimales una caja recién empezada se ve como "0.000 m³", que se lee como vacía
// cuando ya tiene algo adentro. Por debajo de 0.001 m³ se muestra en cm³.
const m3 = (n: number) => (n >= 0.001 || n === 0 ? `${n.toFixed(3)} m³` : `${Math.round(n * 1_000_000)} cm³`)
// Motos que sirve una pieza, solo cuando es más de una: de las 4.258 piezas del catálogo,
// 1.922 sirven a una sola moto, así que "1 moto" sería ruido en la mayoría de las filas.
const chipMotos = (compatibleModels: string | null) => {
  const motos = parseModelos(compatibleModels)
  return motos.length > 1 ? { n: motos.length, lista: motos.join(', ') } : null
}

// Ficha de un embarque MARÍTIMO. Es un documento distinto del aéreo, no una variante:
// lleva mercancía propia (EnvioLinea) en vez de pedidos, se factura por volumen en vez de
// por peso, y se arma pieza por pieza mientras está en borrador.
export default async function EnvioMaritimo({ envioId }: { envioId: number }) {
  const [envio, configRows] = await Promise.all([
    db.envio.findUnique({
      where: { id: envioId },
      include: {
        lineas: {
          include: {
            product: {
              select: {
                id: true, nameEs: true, nameEn: true, bajajCode: true, compatibleModels: true,
                weightGrams: true, dimL: true, dimA: true, dimH: true, priceInr: true,
                discontinuedAt: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        },
        supplier: { select: { id: true, name: true, fobUsd: true } },
      },
    }),
    db.config.findMany(),
  ])
  if (!envio) return null

  const suppliers = await db.supplier.findMany({
    select: { id: true, name: true, fobUsd: true },
    orderBy: { name: 'asc' },
  })

  const cfg = toConfigMap(configRows)
  // El FOB lo pone el PROVEEDOR de este embarque, no una constante global: cada uno cobra
  // lo suyo. Sin proveedor (o sin FOB propio cargado) se cae al default de Config.
  const fobProveedor = envio.supplier?.fobUsd != null ? parseFloat(envio.supplier.fobUsd.toString()) : null
  // Lo que costó la transferencia con la que se le pagó al proveedor de este embarque. Es
  // un costo real que no entraba a ningún lado: salía de la caja y no del landed. Vive en
  // las MISMAS dos columnas que usa el carril aéreo para que la comisión sea un solo
  // concepto y no cuatro campos parecidos en dos pantallas. No se calcula con ninguna
  // regla — se anotan los montos, o quedan sin cargar (que no es cero).
  const dec = (v: { toString(): string } | null) => (v != null ? parseFloat(v.toString()) : null)
  const comisionSalienteUsd = dec(envio.comisionSalienteUsd)
  const comisionEntranteUsd = dec(envio.comisionEntranteUsd)
  const p = cbmParams(cfg, fobProveedor)
  const priceMap = await getSupplierPriceMap(envio.supplier?.id ?? null)
  const esBorrador = envio.estado === 'borrador'
  const nombreEmbarque = envio.nombre ?? `Embarque #${envio.id}`

  // Solo headers de ensamble, y solo mientras se arma: sus piezas se cargan on-demand al
  // seleccionar uno (el catálogo tiene ~14k componentes).
  const assemblies: AssemblyOption[] = esBorrador
    ? await db.product.findMany({
        where: { isAssembly: true },
        select: { id: true, nameEs: true, bajajCode: true, imageUrl: true, compatibleModels: true },
        orderBy: { nameEs: 'asc' },
      })
    : []
  const models = sortModels(modelosDistintos(assemblies.map(a => a.compatibleModels)))

  // Las líneas propias no tienen conjuntos ni precio de venta: son producto y cantidad.
  const resumen = resumirCbm(
    envio.lineas.map(l => ({
      itemId: l.id,
      pedidoId: 0,
      productId: l.productId,
      quantity: l.quantity,
      salePrice: 0,
      bundleItems: null,
      product: l.product,
    })),
    () => undefined,
    cfg,
    { priceMap, fobUsd: fobProveedor },
  )

  // El otro código del par para las piezas que tienen dos: es con ese número que el
  // proveedor las lista, así que es el que hay que poder leer al pedirlas.
  const alternos = await alternosDe(envio.lineas.map(l => l.productId))

  const porLinea = new Map(resumen.piezas.map(x => [x.itemId, x]))
  const lineas: LineaEmbarque[] = envio.lineas.map(l => {
    const x = porLinea.get(l.id)
    return {
      id: l.id,
      productId: l.productId,
      nameEs: l.product.nameEs,
      bajajCode: l.product.bajajCode,
      altCode: alternos.get(l.productId) ?? null,
      // Múltiplo de compra del proveedor de ESTA caja. null = no lo declara, o todavía no
      // hay proveedor elegido.
      moq: priceMap.get(l.productId)?.moq ?? null,
      compatibleModels: l.product.compatibleModels,
      quantity: l.quantity,
      dimL: l.product.dimL,
      dimA: l.product.dimA,
      dimH: l.product.dimH,
      // Por UNIDAD, no por línea: el armador trabaja sobre un borrador local donde las
      // cantidades cambian sin ir al server, así que necesita poder multiplicar él. Para
      // una línea que no se toca, unidad × cantidad reproduce el número de resumirCbm.
      volumeUnitM3: (x?.volumeM3 ?? 0) / l.quantity,
      weightUnitKg: (x?.weightKg ?? 0) / l.quantity,
      costoUnitUsd: (x?.costoOrigenUsd ?? 0) / l.quantity,
      sinMedidas: x?.sinMedidas ?? true,
      descontinuada: l.product.discontinuedAt != null,
    }
  })

  // Líneas que no llegan al mínimo del proveedor: no se pueden comprar tal cual. No se
  // corrigen solas — subir la cantidad es una decisión de compra (¿me sirven 50 de esto?)
  // y además mueve el volumen de la caja.
  const bajoMinimo = lineas.filter(l => !cumpleMoq(l.quantity, l.moq))

  // Piezas que se marcaron como descontinuadas DESPUÉS de entrar a la caja. El armador no
  // deja agregarlas, así que solo pueden llegar acá por ese camino — y hay que sacarlas a
  // mano: el embarque no se puede guardar mientras estén.
  const descontinuadas = lineas.filter(l => l.descontinuada)

  // Costo REAL de la caja: el mínimo facturable adentro. El prorrateo por m³ que usa el
  // catálogo sirve para costear una pieza suelta, pero acá esconde justamente lo que hay
  // que ver — que una caja a medio llenar paga aire.
  const embarque = costoEmbarque(resumen.volumeM3, cfg, fobProveedor, {
    mercanciaUsd: resumen.costoOrigenUsd,
    comisionSalienteUsd,
    comisionEntranteUsd,
  })
  const landedReal =
    resumen.costoOrigenUsd +
    (resumen.volumeM3 > 0 ? embarque.totalUsd : 0) +
    embarque.comisionUsd
  // Con la caja casi vacía, cualquier ratio contra el volumen se dispara a millones: no es
  // información, es una división por casi-cero. Recién a partir del 1% del mínimo los
  // números por m³ (y la densidad) describen algo real.
  const hayVolumenUtil = resumen.volumeM3 >= p.minM3 * 0.01
  const realPorM3 = hayVolumenUtil ? costoRealPorM3(resumen.volumeM3, cfg, fobProveedor) : null

  // Comparación de proveedores para ESTA canasta. Se calcula sobre el embarque completo
  // (no pieza por pieza) porque el FOB es fijo por caja — ver lib/comparar-proveedores.
  const opciones = envio.lineas.length > 0
    ? await compararProveedores(
        envio.lineas.map(l => ({
          productId: l.productId,
          quantity: l.quantity,
          priceInr: l.product.priceInr,
          dimL: l.product.dimL,
          dimA: l.product.dimA,
          dimH: l.product.dimH,
        })),
        cfg,
        envio.supplierId,
      )
    : []

  // Carga de medidas: UN GRUPO POR ENSAMBLE, igual que en el presupuesto. La caja se arma
  // recorriendo despieces, así que sus piezas vienen de unos pocos ensambles — pero la
  // línea no guarda de cuál (es producto y cantidad, nada más), hay que reconstruirlo
  // desde ProductComponent. Mandar las 126 piezas juntas es justamente la tanda que
  // degrada la respuesta de la IA y vuelve imposible auditarla.
  const enlaces = envio.lineas.length > 0
    ? await db.productComponent.findMany({
        where: { childId: { in: envio.lineas.map(l => l.productId) } },
        select: { childId: true, parentId: true, parent: { select: { nameEs: true, bajajCode: true } } },
      })
    : []

  // Se agrupa por NOMBRE del ensamble, no por su id: el mismo despiece existe como varias
  // filas de Product (una por variante de color o de año — hay dos "Headlamp Fairing" y dos
  // "Mudguard"). Por id salían dos pestañas con el mismo título y la pieza estaba en una
  // sola: buscarla ahí es indistinguible de que falte.
  const ensambles = new Map<string, { nombre: string; sku: string | null; hijos: Set<number> }>()
  for (const e of enlaces) {
    const clave = e.parent.nameEs.trim().toLowerCase()
    const g = ensambles.get(clave)
      ?? { nombre: e.parent.nameEs.trim(), sku: e.parent.bajajCode, hijos: new Set<number>() }
    // Variantes distintas del mismo despiece no comparten código: sin uno solo que valga
    // para el grupo, mejor ninguno que el de una de ellas.
    if (g.sku !== e.parent.bajajCode) g.sku = null
    g.hijos.add(e.childId)   // el mismo hijo puede venir repetido: uno por subgrupo del ensamble
    ensambles.set(clave, g)
  }

  // Una pieza cuelga de varios ensambles (un tornillo está en veinte), así que hay que
  // elegirle uno. Gana el que cubre más piezas TODAVÍA sin asignar: eso reconstruye cómo
  // se armó la caja — ensamble por ensamble — y deja cada pieza en un solo grupo, que es
  // lo que hace que la tanda se pueda auditar sin cruzar pestañas.
  const pendientes = new Set(envio.lineas.map(l => l.productId))
  const asignado = new Map<number, string>()   // productId → ensamble
  const orden: string[] = []
  for (;;) {
    let mejor: { clave: string; n: number } | null = null
    for (const [clave, g] of ensambles) {
      let n = 0
      for (const hijo of g.hijos) if (pendientes.has(hijo)) n++
      // Empate: gana el alfabético, para que el orden de las pestañas no cambie solo.
      if (n > 0 && (mejor == null || n > mejor.n || (n === mejor.n && clave < mejor.clave))) mejor = { clave, n }
    }
    if (mejor == null) break
    for (const hijo of ensambles.get(mejor.clave)!.hijos) {
      if (pendientes.delete(hijo)) asignado.set(hijo, mejor.clave)
    }
    orden.push(mejor.clave)
  }

  type LineaConProducto = (typeof envio.lineas)[number]
  const comoPieza = (l: LineaConProducto): PiezaMedible => ({
    id: l.product.id,
    bajajCode: l.product.bajajCode,
    nameEs: l.product.nameEs,
    nameEn: l.product.nameEn,
    compatibleModels: l.product.compatibleModels,
    quantity: l.quantity,
    weightGrams: l.product.weightGrams,
    dimL: l.product.dimL,
    dimA: l.product.dimA,
    dimH: l.product.dimH,
  })

  const grupos: GrupoMedidas[] = []
  const sueltas: PiezaMedible[] = []
  // Un grupo de UNA pieza se queda con el nombre de su ensamble igual. Llevar una sola
  // pieza de un despiece es lo normal armando stock (un cable de acelerador, un tapón de
  // tanque), y mandarlas todas juntas a "sueltas" era mentir sobre de dónde salieron:
  // justo el dato que sirve para investigarla.
  for (const clave of orden) {
    const g = ensambles.get(clave)!
    grupos.push({
      key: `ens-${clave}`,
      titulo: g.nombre,
      subtitulo: g.sku,
      piezas: envio.lineas.filter(l => asignado.get(l.productId) === clave).map(comoPieza),
    })
  }
  // Piezas que no cuelgan de ningún ensamble: solo las que se agregaron por el buscador,
  // o las que llegaron al catálogo sin despiece. Si el embarque se armó recorriendo
  // ensambles, esta tanda no existe y la pestaña no aparece.
  sueltas.push(...envio.lineas.filter(l => !asignado.has(l.productId)).map(comoPieza))
  if (sueltas.length > 0) {
    grupos.push({ key: 'sueltas', titulo: 'Piezas sueltas', piezas: sueltas })
  }

  return (
    <div className="max-w-5xl space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/envios" className="text-gray-400 hover:text-gray-600 text-sm">Envíos</Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">#{envio.id}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{nombreEmbarque}</h1>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-cyan-100 text-cyan-800">
              🚢 Marítimo CBM
            </span>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              esBorrador ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'
            }`}>
              {esBorrador ? 'Borrador' : 'Cerrado'}
            </span>
            <SelectorProveedorEmbarque
              envioId={envio.id}
              supplierId={envio.supplierId}
              suppliers={suppliers.map(sp => ({
                id: sp.id,
                name: sp.name,
                fobUsd: sp.fobUsd != null ? parseFloat(sp.fobUsd.toString()) : null,
              }))}
              fobEfectivoUsd={p.fobUsd}
              editable={esBorrador}
            />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {envio.notas ?? 'Mercancía propia que viaja por barco. Sin clientes: cuando llega, entra a stock.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {esBorrador ? (
            <form action={cerrarEmbarque.bind(null, envio.id)}>
              <button
                type="submit"
                disabled={lineas.length === 0}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors font-medium"
              >
                Cerrar embarque
              </button>
            </form>
          ) : (
            <form action={reabrirEmbarque.bind(null, envio.id)}>
              <button type="submit" className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Reabrir
              </button>
            </form>
          )}
          <DeleteButton
            action={deleteEnvio.bind(null, envio.id)}
            confirmMessage={`¿Eliminar el embarque "${envio.nombre ?? `#${envio.id}`}"?`}
          />
        </div>
      </div>

      {/* Costo del embarque */}
      {lineas.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Costo del embarque</h2>
            {embarque.pagaMinimo && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
                Pagando el mínimo
              </span>
            )}
          </div>

          {descontinuadas.length > 0 && (
            <p className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">
              <span className="font-semibold">
                {descontinuadas.length} pieza{descontinuadas.length === 1 ? '' : 's'} descontinuada
                {descontinuadas.length === 1 ? '' : 's'} adentro de la caja:{' '}
                {descontinuadas.slice(0, 3).map(l => l.bajajCode ?? l.nameEs).join(', ')}
                {descontinuadas.length > 3 && `… y ${descontinuadas.length - 3} más`}.
              </span>{' '}
              Bajaj no las fabrica más, así que no se le pueden comprar a ningún proveedor. Sacalas del embarque
              — mientras estén, no se puede guardar.
            </p>
          )}

          {resumen.sinMedidas > 0 && (
            <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-4 py-3 text-sm">
              <span className="font-semibold">{resumen.sinMedidas} pieza{resumen.sinMedidas === 1 ? '' : 's'} sin medir.</span>{' '}
              No suman volumen: el m³ real de esta caja es mayor que el que ves. Cargalas abajo antes de cerrarla.
            </p>
          )}

          {bajoMinimo.length > 0 && (
            <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-4 py-3 text-sm">
              <span className="font-semibold">
                {bajoMinimo.length} línea{bajoMinimo.length === 1 ? '' : 's'} por debajo del mínimo de{' '}
                {envio.supplier?.name ?? 'el proveedor'}.
              </span>{' '}
              Esas cantidades no se pueden pedir: hay que subirlas hasta el mínimo o sacar la pieza de la caja.
              Ajustalas abajo — cada una te dice cuánto le falta.
            </p>
          )}

          {resumen.excedeDensidad && hayVolumenUtil && (
            <p className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">
              Densidad de {Math.round(resumen.densidad!)} kg/m³, por encima del tope de {CBM_MAX_KG_PER_M3} kg/m³.
              Con esta carga la naviera puede cobrar por peso en vez de por volumen.
            </p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Volumen</p>
              <p className="text-xl font-bold font-mono text-blue-700">{m3(resumen.volumeM3)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Facturable</p>
              <p className={`text-xl font-bold font-mono ${embarque.pagaMinimo ? 'text-amber-700' : 'text-gray-900'}`}>
                {m3(embarque.facturableM3)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Flete + FOB</p>
              <p className="text-xl font-bold font-mono text-gray-900">{usd(embarque.totalUsd)}</p>
              <p className="text-[11px] text-gray-400">{usd(embarque.fleteUsd)} + {usd(embarque.fobUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Costo real / m³</p>
              <p className={`text-xl font-bold font-mono ${embarque.pagaMinimo ? 'text-amber-700' : 'text-gray-900'}`}>
                {realPorM3 != null ? usd(realPorM3) : '—'}
              </p>
              <p className="text-[11px] text-gray-400">
                {realPorM3 != null ? `tarifa ${usd(p.ratePerM3)}` : 'muy poco volumen para medirlo'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Mercancía</p>
              <p className="text-xl font-bold font-mono text-gray-900">{usd(resumen.costoOrigenUsd)}</p>
              <p className="text-[11px] text-gray-400">{resumen.weightKg.toFixed(1)} kg</p>
            </div>
            {/* La comisión solo tiene dónde cargarse si el embarque tiene proveedor: sin
                proveedor no hay a quién girarle (es el precio base de 99rpm). */}
            {envio.supplierId != null && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Comisiones del giro</p>
                <p className={`text-xl font-bold font-mono ${embarque.cargada ? 'text-gray-900' : 'text-gray-300'}`}>
                  {!embarque.salienteCargada && !embarque.entranteCargada
                    ? 'sin cargar'
                    : usd(embarque.comisionUsd)}
                </p>
                <p className="text-[11px] text-gray-400">
                  {embarque.cargada
                    ? `saliente ${usd(embarque.comisionSalienteUsd)} + entrante ${usd(embarque.comisionEntranteUsd)}`
                    : embarque.salienteCargada
                      ? 'falta la entrante'
                      : embarque.entranteCargada
                        ? 'falta la saliente'
                        : `sobre ${usd(embarque.giroUsd)} girados`}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400 mb-1">Landed total</p>
              <p className="text-xl font-bold font-mono text-blue-700">{usd(landedReal)}</p>
              <p className="text-[11px] text-gray-400">
                {resumen.costoOrigenUsd > 0 && hayVolumenUtil
                  ? `+${((embarque.totalUsd / resumen.costoOrigenUsd) * 100).toFixed(0)}% sobre la mercancía`
                  : `mercancía ${usd(resumen.costoOrigenUsd)} + envío ${usd(embarque.totalUsd)}`}
              </p>
            </div>
          </div>

          {/* Dónde se anotan las dos comisiones del giro. Estaban solo en el carril aéreo,
              así que un embarque marítimo mostraba "sin cargar" para siempre: el costo
              existía y no había pantalla donde meterlo. Es la misma acción y las mismas dos
              columnas — una comisión es un concepto solo, no uno por ruta. */}
          {envio.supplierId != null && (
            <form
              action={saveCostosProveedor.bind(null, envio.id)}
              className="pt-4 border-t border-gray-100 flex flex-wrap items-end gap-3"
            >
              <div>
                <label
                  className="block text-xs font-medium text-gray-600 mb-1"
                  title="Lo que MI banco cobró por emitir el giro. Vacío = todavía no lo sé; 0 = no cobró nada"
                >
                  Comisión saliente (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  name="comisionSalienteUsd"
                  defaultValue={comisionSalienteUsd ?? ''}
                  placeholder="sin cargar"
                  className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  lo que te cobró tu banco por girar {usd(embarque.giroUsd)}
                </p>
              </div>
              <div>
                <label
                  className="block text-xs font-medium text-gray-600 mb-1"
                  title="Lo que le descontaron a ÉL al acreditar y tuviste que completarle. Vacío = todavía no lo sé; 0 = le llegó completo"
                >
                  Comisión entrante (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  name="comisionEntranteUsd"
                  defaultValue={comisionEntranteUsd ?? ''}
                  placeholder="sin cargar"
                  className="w-40 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  lo que le descontaron al recibir y le completaste
                </p>
              </div>
              <button
                type="submit"
                className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Guardar
              </button>
              {!embarque.cargada && (
                <p className="text-[11px] text-gray-400 basis-full">
                  Vacío no es cero: mientras falte una punta, esa parte cuenta $0 y el landed sale corto.
                </p>
              )}
            </form>
          )}

          {/* Curva de dilución del FOB: es la decisión de CUÁNDO mandar. El flete escala
              con el volumen, el FOB no — así que el costo por m³ baja al llenar, y hasta
              el mínimo facturable baja en picada. */}
          <div className="pt-4 border-t border-gray-100 text-xs text-gray-500">
            <span className="font-medium text-gray-600">Costo por m³ según cuánto lleves:</span>{' '}
            {[p.minM3, Math.max(p.minM3, 1) * 2, Math.max(p.minM3, 1) * 3].map((v, i) => (
              <span key={v}>
                {i > 0 && ' · '}
                <span className="font-mono">
                  {v} m³ → {usd((Math.max(v, p.minM3) * p.ratePerM3 + p.fobUsd) / v)}/m³
                </span>
              </span>
            ))}
            {embarque.pagaMinimo && realPorM3 != null && (
              <span className="font-mono text-amber-700"> · vos hoy: {usd(realPorM3)}/m³</span>
            )}
            {embarque.pagaMinimo && realPorM3 == null && (
              <span className="text-amber-700"> · hoy llevás tan poco que el flete es casi todo el costo</span>
            )}
            <span className="block mt-1 text-gray-400">
              Llenar más no abarata el flete: abarata el FOB de {usd(p.fobUsd)}, que se reparte entre más mercancía.
            </span>
          </div>
        </div>
      )}

      {esBorrador ? (
        <EmbarqueMaritimo
          envioId={envio.id}
          nombre={nombreEmbarque}
          proveedor={envio.supplier?.name ?? null}
          lineas={lineas}
          volumeM3={resumen.volumeM3}
          minM3={p.minM3}
          ratePerM3={p.ratePerM3}
          fobUsd={p.fobUsd}
          assemblies={assemblies}
          models={models}
        />
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {/* Copiar sirve tanto o más con la caja cerrada que armándola: es la lista que se
              le pasa al proveedor para cerrar la compra, y a esa altura ya no cambia. */}
          <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">
              Contenido · {lineas.length} línea{lineas.length === 1 ? '' : 's'}
            </h2>
            <CopiarJson
              obtener={() => embarqueAJson(
                { embarque: nombreEmbarque, proveedor: envio.supplier?.name ?? null },
                lineas,
              )}
              label={`Copiar JSON (${lineas.length})`}
              title="Copiar el contenido del embarque como JSON"
              className="shrink-0 border border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors"
            />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-semibold">Pieza</th>
                <th className="text-center px-3 py-3 font-semibold">Cant.</th>
                <th className="text-right px-3 py-3 font-semibold" title="L×A×H en cm">Medidas</th>
                <th className="text-right px-3 py-3 font-semibold">m³</th>
                <th className="text-right px-4 py-3 font-semibold">Costo origen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {lineas.map(l => {
                const motos = chipMotos(l.compatibleModels)
                return (
                <tr key={l.id}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/products/${l.productId}`}
                      className={`hover:text-blue-600 ${l.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}`}
                    >
                      {l.nameEs}
                    </Link>
                    <ChipDescontinuada activo={l.descontinuada} />
                    {l.bajajCode && <span className="ml-2 font-mono text-xs text-gray-400">{l.bajajCode}</span>}
                    {l.altCode && (
                      <span className="ml-1 font-mono text-xs text-gray-300" title="El otro código de la misma pieza">
                        / {l.altCode}
                      </span>
                    )}
                    {l.moq != null && l.moq > 1 && (
                      <span
                        className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          cumpleMoq(l.quantity, l.moq) ? 'bg-gray-100 text-gray-600' : 'bg-amber-100 text-amber-800'
                        }`}
                        title={`Mínimo de compra: ${l.moq} unidades`}
                      >
                        mín. {l.moq}
                      </span>
                    )}
                    {motos && (
                      <span
                        className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600"
                        title={motos.lista}
                      >
                        🏍 {motos.n} motos
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-600">{l.quantity}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 text-xs">
                    {l.dimL && l.dimA && l.dimH ? `${l.dimL}×${l.dimA}×${l.dimH}` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-700">{m3(l.volumeUnitM3 * l.quantity)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-700">{usd(l.costoUnitUsd * l.quantity)}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {opciones.length > 0 && (
        <CompararProveedores
          envioId={envio.id}
          opciones={opciones}
          editable={esBorrador}
          piezas={lineas}
          embarque={nombreEmbarque}
        />
      )}

      {grupos.length > 0 && (
        <MedidasIA
          grupos={grupos}
          revalidate={`/envios/${envio.id}`}
          titulo="Cargar peso y medidas de este embarque"
          defaultOpen={resumen.sinMedidas > 0}
        />
      )}
    </div>
  )
}
