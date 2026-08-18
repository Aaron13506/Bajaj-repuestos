'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import VisorEnsamble from '@/components/VisorEnsamble'
import CopiarJson from '@/components/CopiarJson'
// Pieza que Bajaj dejó de fabricar. Se sigue mostrando, tachada: si la estás buscando es
// porque la necesitás, y enterarte de que ya no se fabrica es la respuesta — que desaparezca
// del despiece parecería un error del catálogo y te mandaría a buscarla de nuevo.
import ChipDescontinuada from '@/components/ChipDescontinuada'
import { parseModelos, sirveParaModelo } from '@/lib/modelos'
import { cumpleMoq, cantidadMinima } from '@/lib/moq'
import { ensambleAJson } from '@/lib/export-ensamble'
import { embarqueAJson } from '@/lib/export-embarque'
import { buscarProductos, componentesDeEnsamble, sincronizarLineas } from '@/app/(pages)/envios/linea-actions'

// ─────────────────────────────────────────────────────────────────────────────
// Armador de un embarque marítimo en borrador.
//
// Acá se carga MERCANCÍA PROPIA pieza por pieza. No hay cliente, ni precio de venta, ni
// adelanto: es una lista de compra. Lo único que importa mientras se arma es cuánto
// volumen llevás contra el mínimo que la naviera factura igual — porque hasta llegar a ese
// piso, cada pieza que agregás viaja sin costo de flete adicional.
//
// El contenido se edita sobre un BORRADOR LOCAL y se guarda de una sola vez. Armar una
// caja son decenas de altas, bajas y correcciones seguidas: contra una base remota, hacer
// un viaje por click volvía lento justo el momento en que uno está explorando ("¿y si
// llevo 20 de esto?"). Además, mientras nada se escribió, deshacer es gratis — sacar una
// pieza sin querer se arregla con un botón en vez de con memoria.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaEmbarque {
  /** id de EnvioLinea. Las piezas agregadas y todavía sin guardar llevan id negativo. */
  id: number
  productId: number
  nameEs: string
  bajajCode: string | null
  /** El otro código del par, para las piezas que Bajaj publica con dos números. */
  altCode: string | null
  /** Cantidad mínima del proveedor de esta caja. null = no la declara o no hay proveedor. */
  moq: number | null
  compatibleModels: string | null
  quantity: number
  dimL: number | null
  dimA: number | null
  dimH: number | null
  // Por UNIDAD: la cantidad cambia en el borrador sin pasar por el server, así que los
  // totales de la línea se recalculan acá multiplicando.
  volumeUnitM3: number
  weightUnitKg: number
  costoUnitUsd: number
  sinMedidas: boolean
  /** Bajaj no la fabrica más. Puede estar en una caja si se marcó DESPUÉS de cargarla. */
  descontinuada: boolean
}

interface Resultado {
  id: number
  nameEs: string
  bajajCode: string | null
  altCode: string | null
  moq: number | null
  compatibleModels: string | null
  costoUsd: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  imageUrl: string | null
  weightKg: number
  volumeM3: number
  sinMedidas: boolean
  descontinuada: boolean
}

export interface AssemblyOption {
  id: number
  nameEs: string
  bajajCode: string | null
  imageUrl: string | null
  compatibleModels: string | null
}

interface Componente {
  id: number
  groupName: string
  quantity: number
  child: {
    id: number
    nameEs: string
    bajajCode: string | null
    altCode: string | null
    moq: number | null
    compatibleModels: string | null
    costoUsd: number | null
    dimL: number | null
    dimA: number | null
    dimH: number | null
    sinMedidas: boolean
    weightKg: number
    volumeM3: number
    descontinuada: boolean
  }
}

interface Props {
  envioId: number
  /** Nombre del embarque y proveedor elegido: solo para rotular el JSON que se copia. */
  nombre: string
  proveedor: string | null
  lineas: LineaEmbarque[]
  volumeM3: number
  minM3: number
  ratePerM3: number
  fobUsd: number
  assemblies: AssemblyOption[]
  models: string[]
}

const usd = (n: number) => `$${n.toFixed(2)}`

// Un tornillo ocupa ~0.000002 m³: con 4 decimales se ve "0.0000 m³", que se lee como "no
// ocupa nada" cuando en realidad sí ocupa. Por debajo de 0.001 m³ se muestra en cm³.
const vol = (m: number) => (m >= 0.001 ? `${m.toFixed(4)} m³` : `${Math.round(m * 1_000_000)} cm³`)
// L×A×H en cm. Sin las tres no hay caja, así que no se muestra media medida.
const dims = (l: number | null, a: number | null, h: number | null) =>
  l && a && h ? `${l}×${a}×${h}` : null

// Cuántas motos sirve una pieza. Se muestra solo cuando es más de una: de las 4.258 piezas
// del catálogo, 1.922 sirven a una sola moto — poner "1 moto" en todas sería ruido en la
// mayoría de las filas para no decir nada. La coincidencia es la excepción, y por eso vale
// la pena señalarla justo cuando aparece.
const chipMotos = (compatibleModels: string | null) => {
  const motos = parseModelos(compatibleModels)
  return motos.length > 1 ? { n: motos.length, lista: motos.join(', ') } : null
}

// El otro número de la misma pieza. Bajaj publica muchas con dos códigos y cada proveedor
// usa el suyo, así que al pedirla hay que poder leer los dos: el de mi catálogo no siempre
// es el que entiende el que me vende.
function CodigoAlterno({ code }: { code: string | null }) {
  if (!code) return null
  return (
    <span className="ml-1 text-xs font-mono text-gray-300" title="El otro código de la misma pieza">
      / {code}
    </span>
  )
}

// Cantidad mínima del proveedor. Solo se dibuja con MOQ > 1: un "mín. 1" en cada fila
// sería ruido para decir "se puede comprar de a una", que es lo que uno ya supone.
// Ámbar cuando la cantidad no llega al piso — ahí el chip deja de ser un dato y pasa a
// ser algo para arreglar antes de mandar la compra.
function ChipMoq({ moq, cantidad, costoUsd }: { moq: number | null; cantidad?: number; costoUsd?: number | null }) {
  if (!moq || moq <= 1) return null
  const ok = cantidad == null || cumpleMoq(cantidad, moq)
  const cuanto = costoUsd != null ? ` — llevar el mínimo son ${usd(costoUsd * moq)}` : ''
  return (
    <span
      className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
        ok ? 'bg-gray-100 text-gray-600' : 'bg-amber-100 text-amber-800'
      }`}
      title={`Mínimo de compra: ${moq} unidades${cuanto}`}
    >
      mín. {moq}
    </span>
  )
}

export default function EmbarqueMaritimo({
  envioId, nombre, proveedor, lineas, volumeM3, minM3, ratePerM3, fobUsd, assemblies, models,
}: Props) {
  const [search, setSearch] = useState('')
  const [resultados, setResultados] = useState<Resultado[]>([])
  const [pending, startTransition] = useTransition()

  // ── Borrador local ────────────────────────────────────────────────────────
  // `borrador` es lo que ves; `lineas` es lo que hay escrito. Mientras difieran hay
  // cambios sin guardar, y ESA es la única fuente del estado "sucio": no hace falta
  // llevar una lista de operaciones, alcanza con comparar contra lo que vino del server.
  const [borrador, setBorrador] = useState<LineaEmbarque[]>(lineas)
  // Pila de estados anteriores. Guardar el array entero y no un diff es deliberado: son
  // decenas de líneas, no miles, y un snapshot no puede quedar desincronizado de lo que
  // deshace. Deshacer tiene que ser lo más confiable de la pantalla — es la red que hace
  // que borrar sin miedo sea razonable.
  const [historial, setHistorial] = useState<LineaEmbarque[][]>([])
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Cuando el server confirma (o cambia por otro motivo), el borrador vuelve a partir de
  // la verdad y el historial se descarta: deshacer hacia un estado ya guardado sería
  // prometer algo que este componente no puede cumplir.
  const servidorKey = lineas.map(l => `${l.id}:${l.quantity}`).join(',')
  useEffect(() => {
    setBorrador(lineas)
    setHistorial([])
    // `lineas` cambia de identidad en cada render; la clave es lo que de verdad cambió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servidorKey])

  // Marca de la última edición, para agrupar. Sin esto, tipear "50" en una cantidad dejaba
  // dos pasos de historial ("5" y "50") y deshacer se volvía tecla por tecla.
  const ultimaEdicion = useRef<string | null>(null)

  /**
   * Único punto de modificación del borrador, y por lo tanto el único que empuja al
   * historial: no existe un cambio que Deshacer no alcance.
   *
   * `agrupar` junta ediciones consecutivas del mismo tipo en un solo paso — todas las
   * teclas de una misma cantidad son un cambio, no seis. Se llama SIEMPRE desde un
   * handler de evento, nunca dentro de un updater de setState: React puede correr los
   * updaters dos veces y el historial terminaría con entradas duplicadas.
   */
  const editar = (fn: (prev: LineaEmbarque[]) => LineaEmbarque[], agrupar?: string) => {
    setError(null)
    if (agrupar == null || agrupar !== ultimaEdicion.current) {
      setHistorial(h => [...h.slice(-49), borrador])
    }
    ultimaEdicion.current = agrupar ?? null
    setBorrador(fn(borrador))
  }

  const deshacer = () => {
    if (historial.length === 0) return
    ultimaEdicion.current = null
    setBorrador(historial[historial.length - 1])
    setHistorial(h => h.slice(0, -1))
  }

  const descartar = () => {
    ultimaEdicion.current = null
    setHistorial(h => [...h.slice(-49), borrador])
    setBorrador(lineas)
  }

  // Suma una pieza a una lista. Es una función pura sobre la lista para poder encadenarla:
  // el alta en lote son N piezas en UNA sola edición, y por lo tanto un solo Deshacer.
  const sumarPieza = (
    lista: LineaEmbarque[],
    pieza: Omit<LineaEmbarque, 'id' | 'quantity'>,
    cantidad: number,
  ): LineaEmbarque[] => {
    const i = lista.findIndex(l => l.productId === pieza.productId)
    // Agregar dos veces la misma pieza es querer más unidades, no un error: se suma a la
    // línea que ya está, igual que hacía el upsert del server.
    if (i >= 0) {
      const copia = [...lista]
      copia[i] = { ...copia[i], quantity: copia[i].quantity + cantidad }
      return copia
    }
    // id negativo = todavía no existe en la base. Se deriva del mínimo actual para que no
    // haya dos iguales dentro de la misma tanda; solo se usa como key de React.
    const id = Math.min(0, ...lista.map(l => l.id)) - 1
    return [...lista, { ...pieza, id, quantity: cantidad }]
  }

  const agregarPiezas = (items: { pieza: Omit<LineaEmbarque, 'id' | 'quantity'>; cantidad: number }[]) => {
    if (items.length === 0) return
    editar(prev => items.reduce((acc, it) => sumarPieza(acc, it.pieza, it.cantidad), prev))
  }

  const cambios = useMemo(() => {
    const antes = new Map(lineas.map(l => [l.productId, l.quantity]))
    let altas = 0, modificadas = 0, bajas = 0
    for (const l of borrador) {
      const q = antes.get(l.productId)
      if (q == null) altas++
      else if (q !== l.quantity) modificadas++
      antes.delete(l.productId)
    }
    bajas = antes.size
    return { altas, modificadas, bajas, total: altas + modificadas + bajas }
  }, [borrador, lineas])

  const sucio = cambios.total > 0

  // El server rechaza el embarque entero si tiene descontinuadas (ver sincronizarLineas).
  // Se refleja acá para no gastar un viaje en un guardado que ya se sabe que va a fallar, y
  // sobre todo para que el motivo se lea al lado del botón que no anda.
  const bloqueadas = borrador.filter(l => l.descontinuada)

  // Salir con cambios sin guardar pierde el armado. El navegador solo deja mostrar su
  // propio cartel, pero alcanza para no perder media hora de trabajo por un Ctrl+W.
  useEffect(() => {
    if (!sucio) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [sucio])

  const guardar = () => {
    setGuardando(true)
    setError(null)
    startTransition(async () => {
      const r = await sincronizarLineas(
        envioId,
        borrador.map(l => ({ productId: l.productId, quantity: l.quantity })),
      )
      setGuardando(false)
      // Si falló, el borrador queda como estaba: lo que venías armando no se pierde por
      // un error de red.
      if (!r.ok) setError(r.error ?? 'No se pudo guardar.')
    })
  }

  // ── Navegador de ensambles ────────────────────────────────────────────────
  // Llenar un contenedor no es tipear códigos sueltos: es recorrer las familias de piezas
  // que uno quiere tener en stock. Mismo recorrido que el armador de presupuestos —
  // moto → ensamble → piezas — porque es la forma en que está organizado el catálogo.
  const [modelFilter, setModelFilter] = useState('')
  const [asmSearch, setAsmSearch] = useState('')
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<number | null>(null)
  const [compCache, setCompCache] = useState<Record<number, Componente[]>>({})
  const [loadingComps, setLoadingComps] = useState(false)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [quantities, setQuantities] = useState<Record<number, number>>({})

  const filteredAssemblies = useMemo(() => {
    const q = asmSearch.trim().toLowerCase()
    return assemblies.filter(a => {
      if (modelFilter && !sirveParaModelo(a.compatibleModels, modelFilter)) return false
      if (!q) return true
      return a.nameEs.toLowerCase().includes(q) || !!a.bajajCode?.toLowerCase().includes(q)
    })
  }, [assemblies, modelFilter, asmSearch])

  const selectedAssembly = assemblies.find(a => a.id === selectedAssemblyId) ?? null
  const componentes = selectedAssemblyId != null ? compCache[selectedAssemblyId] : undefined

  async function selectAssembly(id: number | null) {
    setSelectedAssemblyId(id)
    setChecked({})
    setQuantities({})
    if (id != null && !compCache[id]) {
      setLoadingComps(true)
      try {
        const comps = await componentesDeEnsamble(id, envioId)
        setCompCache(prev => ({ ...prev, [id]: comps }))
      } finally {
        setLoadingComps(false)
      }
    }
  }

  const grupos = useMemo(() => {
    const map = new Map<string, Componente[]>()
    for (const c of componentes ?? []) {
      const key = c.groupName || '—'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(c)
    }
    return map
  }, [componentes])

  // Lo que suma al embarque si mandás lo marcado — el número que decide si vale la pena.
  // Las descontinuadas quedan afuera aunque figuren tildadas: el checkbox está deshabilitado,
  // pero una pieza puede marcarse como descontinuada MIENTRAS tenés el ensamble abierto, y
  // el estado local no se entera. Filtrar acá es lo que hace que eso no termine en la caja.
  const marcadas = (componentes ?? []).filter(c => checked[c.id] && !c.child.descontinuada)
  const volumenMarcado = marcadas.reduce(
    (s, c) => s + c.child.volumeM3 * (quantities[c.id] ?? c.quantity), 0,
  )
  const sinMedidasMarcadas = marcadas.filter(c => c.child.sinMedidas).length
  const costoMarcado = marcadas.reduce(
    (s, c) => s + (c.child.costoUsd ?? 0) * (quantities[c.id] ?? c.quantity), 0,
  )
  // La cantidad que trae el ensamble es cuántas lleva la moto (2 tornillos, 1 tapa), y casi
  // nunca llega al mínimo del proveedor. Se avisa acá, antes del alta, que es cuando
  // todavía es una cantidad y no una línea del embarque.
  const bajoMinimoMarcadas = marcadas.filter(
    c => !cumpleMoq(quantities[c.id] ?? c.quantity, c.child.moq),
  )

  // El alta ahora es local, así que la selección se puede limpiar en el acto: ya no hay
  // que esperar a que vuelva el server (antes, limpiarla antes de tiempo vaciaba el form).
  const agregarMarcadas = () => {
    agregarPiezas(marcadas.map(c => ({
      pieza: {
        productId: c.child.id,
        nameEs: c.child.nameEs,
        bajajCode: c.child.bajajCode,
        altCode: c.child.altCode,
        moq: c.child.moq,
        compatibleModels: c.child.compatibleModels,
        dimL: c.child.dimL,
        dimA: c.child.dimA,
        dimH: c.child.dimH,
        volumeUnitM3: c.child.volumeM3,
        weightUnitKg: c.child.weightKg,
        costoUnitUsd: c.child.costoUsd ?? 0,
        sinMedidas: c.child.sinMedidas,
        descontinuada: c.child.descontinuada,
      },
      cantidad: quantities[c.id] ?? c.quantity,
    })))
    setChecked({})
    setQuantities({})
  }

  // ── Copiar el ensamble como JSON ──────────────────────────────────────────
  // Sacar el ensamble entero de la app para trabajarlo afuera: cotizarlo con un proveedor o
  // mandarlo a buscar las medidas que faltan. Se copia lo MARCADO cuando hay algo marcado y
  // el ensamble completo cuando no: marcar ya es la forma de elegir un subconjunto en esta
  // pantalla, y un segundo gesto para lo mismo obligaría a explicar cuál manda.
  const paraCopiar = marcadas.length > 0 ? marcadas : (componentes ?? [])

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setResultados([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const rows = await buscarProductos(q, envioId)
      if (!cancelled) setResultados(rows)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, envioId])

  // productId → cuánto ya llevás. Es un Map y no un Set porque al recorrer la SEGUNDA moto
  // la pregunta deja de ser "¿está?" y pasa a ser "¿cuánto tengo?": el mismo SKU sirve a
  // varias motos, y volver a agregarlo SUMA a la línea que ya existe en vez de crear una
  // segunda. Sin el número a la vista, ese incremento se lee como si estuvieras fijando el
  // total. Sale del BORRADOR, no de lo guardado: si acabás de agregarla, ya la llevás.
  const yaEnCaja = new Map(borrador.map(l => [l.productId, l.quantity]))

  // De lo que se va a copiar, cuántas piezas ya están en la caja. Solo para rotular el
  // botón: el JSON lleva el número pieza por pieza, pero saber ANTES de copiar que este
  // despiece se pisa con lo que ya llevás es lo que evita mandarlo dos veces al proveedor.
  const repetidasEnEnsamble = paraCopiar.filter(c => (yaEnCaja.get(c.child.id) ?? 0) > 0).length

  // El volumen de lo que estás armando. Con cambios sin guardar difiere del que calculó el
  // server arriba, y es este el que hay que mirar para decidir qué más entra.
  const volumenBorrador = borrador.reduce((s, l) => s + l.volumeUnitM3 * l.quantity, 0)
  const sobra = minM3 - volumenBorrador
  const pct = Math.min(100, (volumenBorrador / minM3) * 100)

  return (
    <div className="space-y-4">

      {/* Llenado: el dato que decide qué conviene agregar */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <h2 className="font-semibold text-gray-900">Llenado del embarque</h2>
          <span className="text-xs font-mono text-gray-500">
            {volumenBorrador.toFixed(3)} / {minM3} m³ · {usd(ratePerM3)}/m³ · FOB {usd(fobUsd)}
            {sucio && volumenBorrador !== volumeM3 && (
              <span className="text-amber-600"> · guardado: {volumeM3.toFixed(3)}</span>
            )}
          </span>
        </div>
        <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={volumenBorrador >= minM3 ? 'h-full bg-green-500' : 'h-full bg-amber-400'}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {sobra > 0 ? (
            <>
              Te quedan <span className="font-semibold text-gray-700">{sobra.toFixed(3)} m³</span> que vas a pagar
              igual: la naviera factura el mínimo de {minM3} m³ aunque mandes menos. Todo lo que entre ahí no sube
              el flete ni un dólar.
            </>
          ) : (
            <>
              Pasaste el mínimo: de acá en más el flete escala a {usd(ratePerM3)}/m³, pero el FOB de {usd(fobUsd)} se
              reparte entre más mercancía y baja el landed de todo lo que va adentro.
            </>
          )}
        </p>
      </div>

      {/* Navegador de ensambles: moto → ensamble → piezas */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-900 mb-1">Agregar por ensamble</h2>
        <p className="text-xs text-gray-500 mb-4">
          Elegí la moto y el ensamble, y marcá las piezas que querés traer. Es el mismo recorrido del armador de
          presupuestos, pero acá sin precio de venta: es una lista de compra. Recorré las motos de a una — cuando
          una pieza ya esté en la caja te avisa cuánto llevás, así el mismo SKU no se cuenta dos veces.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            value={modelFilter}
            onChange={e => { setModelFilter(e.target.value); selectAssembly(null) }}
          >
            <option value="">— Todas las motos —</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input
            type="text"
            value={asmSearch}
            onChange={e => setAsmSearch(e.target.value)}
            placeholder="Buscar ensamble por nombre o código…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="border border-gray-300 rounded-lg mb-1 max-h-72 overflow-y-auto divide-y divide-gray-50">
          {filteredAssemblies.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">Sin resultados</p>
          ) : (
            filteredAssemblies.slice(0, 200).map(a => (
              <button
                key={a.id}
                type="button"
                onClick={() => selectAssembly(a.id === selectedAssemblyId ? null : a.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  a.id === selectedAssemblyId ? 'bg-cyan-50' : 'hover:bg-gray-50'
                }`}
              >
                {a.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.imageUrl} alt={a.nameEs} loading="lazy" className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{a.nameEs}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {a.bajajCode && <span className="font-mono">{a.bajajCode}</span>}
                    {a.bajajCode && a.compatibleModels && ' · '}
                    {a.compatibleModels}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
        <p className="text-xs text-gray-400 mb-4">
          {filteredAssemblies.length} ensamble{filteredAssemblies.length === 1 ? '' : 's'}
          {modelFilter || asmSearch ? ' (filtrado)' : ''} de {assemblies.length}
          {filteredAssemblies.length > 200 && ' · mostrando los primeros 200, afiná el filtro'}
        </p>

        {selectedAssembly && (
          <div className="border-t border-gray-100 pt-4">
            {/* El despiece se muestra antes que la lista y no espera a que carguen las
                piezas: es con el dibujo que se decide qué traer — la lista de nombres sola
                no dice qué es cada cosa. */}
            {selectedAssembly.imageUrl ? (
              <VisorEnsamble
                src={selectedAssembly.imageUrl}
                nameEs={selectedAssembly.nameEs}
                bajajCode={selectedAssembly.bajajCode}
              />
            ) : (
              <p className="text-xs text-gray-400 mb-4">Este ensamble no tiene despiece cargado.</p>
            )}
            {loadingComps && !componentes ? (
              <p className="text-sm text-gray-400 py-6 text-center">Cargando piezas…</p>
            ) : (
              <>
                <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                  {Array.from(grupos.entries()).map(([groupName, items]) => (
                    <div key={groupName}>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{groupName}</p>
                      <div className="space-y-0.5">
                        {items.map(c => {
                          const yaLlevas = yaEnCaja.get(c.child.id) ?? 0
                          const motos = chipMotos(c.child.compatibleModels)
                          const sumando = checked[c.id] ? (quantities[c.id] ?? c.quantity) : 0
                          return (
                            <label
                              key={c.id}
                              className={`flex items-center gap-3 py-2 px-2 rounded-lg ${
                                c.child.descontinuada
                                  ? 'opacity-60 cursor-not-allowed bg-red-50/40'
                                  : 'cursor-pointer hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={!!checked[c.id]}
                                disabled={c.child.descontinuada}
                                onChange={e => setChecked(prev => ({ ...prev, [c.id]: e.target.checked }))}
                                className="w-4 h-4 rounded border-gray-300 text-blue-600 shrink-0 disabled:cursor-not-allowed"
                              />
                              <span className="flex-1 min-w-0">
                                <span className={`text-sm ${c.child.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                                  {c.child.nameEs}
                                </span>
                                <ChipDescontinuada activo={c.child.descontinuada} />
                                {c.child.bajajCode && (
                                  <span className="ml-2 text-xs font-mono text-gray-400">{c.child.bajajCode}</span>
                                )}
                                <CodigoAlterno code={c.child.altCode} />
                                <ChipMoq
                                  moq={c.child.moq}
                                  cantidad={checked[c.id] ? (quantities[c.id] ?? c.quantity) : undefined}
                                  costoUsd={c.child.costoUsd}
                                />
                                {motos && (
                                  <span
                                    className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600"
                                    title={motos.lista}
                                  >
                                    🏍 {motos.n} motos
                                  </span>
                                )}
                                {c.child.sinMedidas && (
                                  <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                    sin medidas
                                  </span>
                                )}
                                {/* Lo que evita comprar dos veces lo mismo al pasar de una moto a la
                                    otra. Con la pieza tildada se adelanta el total que va a quedar,
                                    porque el alta suma y eso no se ve por ningún lado. */}
                                {yaLlevas > 0 && (
                                  <span className="ml-2 text-xs font-medium text-cyan-700">
                                    ya llevás {yaLlevas}
                                    {sumando > 0 && ` → ${yaLlevas + sumando}`}
                                  </span>
                                )}
                              </span>
                              <span className="text-[11px] font-mono text-gray-500 w-16 text-right shrink-0" title="Costo de compra unitario">
                                {c.child.costoUsd != null ? usd(c.child.costoUsd) : '—'}
                              </span>
                              <span className="text-[11px] font-mono text-gray-400 w-24 text-right shrink-0" title="L×A×H en cm">
                                {dims(c.child.dimL, c.child.dimA, c.child.dimH) ?? '—'}
                              </span>
                              <span className="text-[11px] font-mono text-gray-400 w-20 text-right shrink-0" title="Volumen de la línea">
                                {c.child.sinMedidas ? '—' : vol(c.child.volumeM3 * (quantities[c.id] ?? c.quantity))}
                              </span>
                              <input
                                type="number"
                                min={1}
                                value={quantities[c.id] ?? c.quantity}
                                onChange={e => setQuantities(prev => ({ ...prev, [c.id]: parseInt(e.target.value) || 1 }))}
                                onClick={e => e.stopPropagation()}
                                disabled={!checked[c.id]}
                                className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center disabled:opacity-40 shrink-0"
                              />
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-xs text-gray-500">
                      {marcadas.length === 0 ? (
                        'Marcá las piezas que querés traer.'
                      ) : (
                        <>
                          <span className="font-semibold text-gray-700">{marcadas.length}</span> marcadas ·{' '}
                          <span className="font-mono">{vol(volumenMarcado)}</span> ·{' '}
                          <span className="font-mono">{usd(costoMarcado)}</span>
                          {sinMedidasMarcadas > 0 && (
                            <span className="text-amber-600"> · {sinMedidasMarcadas} sin medidas (no suman volumen todavía)</span>
                          )}
                          {bajoMinimoMarcadas.length > 0 && (
                            <span className="text-amber-600">
                              {' '}· {bajoMinimoMarcadas.length} bajo el mínimo del proveedor:{' '}
                              {bajoMinimoMarcadas.slice(0, 3).map(c => {
                                const q = quantities[c.id] ?? c.quantity
                                return `${q}→${cantidadMinima(q, c.child.moq)}`
                              }).join(', ')}
                              {bajoMinimoMarcadas.length > 3 && '…'}
                            </span>
                          )}
                        </>
                      )}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {/* Copiar no toca el embarque: es para llevarse el ensamble a otro
                          lado (cotizar, buscar medidas). Por eso vive al lado de Agregar
                          pero como acción secundaria.
                          `key` por ensamble: si el portapapeles falló y quedó el texto a la
                          vista, cambiar de ensamble tiene que limpiarlo — si no, se copiaría
                          a mano el JSON del anterior. */}
                      <CopiarJson
                        key={selectedAssemblyId ?? 'ninguno'}
                        obtener={() => ensambleAJson(selectedAssembly, paraCopiar, modelFilter, yaEnCaja)}
                        disabled={paraCopiar.length === 0}
                        label={`Copiar JSON (${paraCopiar.length}${marcadas.length > 0 ? ' marcadas' : ''})`}
                        title={
                          (marcadas.length > 0
                            ? 'Copiar las piezas marcadas como JSON'
                            : 'Copiar el ensamble completo como JSON') +
                          ` — cada pieza lleva "en_caja" con cuántas ya tenés en el embarque${
                            repetidasEnEnsamble > 0
                              ? ` (${repetidasEnEnsamble} de este ensamble ya ${repetidasEnEnsamble === 1 ? 'está' : 'están'} adentro)`
                              : ''
                          }`
                        }
                      />
                      <button
                        type="button"
                        onClick={agregarMarcadas}
                        disabled={marcadas.length === 0}
                        className="bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Agregar {marcadas.length > 0 ? `${marcadas.length} pieza${marcadas.length === 1 ? '' : 's'}` : 'piezas'}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Buscador puntual por código */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-900 mb-3">Agregar una pieza suelta</h2>
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre o código…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          {resultados.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg divide-y divide-gray-50 overflow-hidden max-h-96 overflow-y-auto">
              {resultados.map(r => {
                const yaLlevas = yaEnCaja.get(r.id) ?? 0
                const motos = chipMotos(r.compatibleModels)
                // La primera vez entra el MÍNIMO, no 1: si el proveedor no despacha menos
                // de 50, una línea de 1 describe una compra que no existe. Después ya
                // estás por encima del piso, y de ahí para arriba se suma de a una. El
                // botón dice siempre cuánto va a entrar.
                const paso = yaLlevas === 0 && r.moq && r.moq > 1 ? r.moq : 1
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors"
                  >
                    {r.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.imageUrl} alt={r.nameEs} className="w-10 h-10 object-contain rounded border border-gray-100 bg-white shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded border border-gray-100 bg-gray-50 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        <span className={r.descontinuada ? 'text-gray-500 line-through' : undefined}>{r.nameEs}</span>
                        <ChipDescontinuada activo={r.descontinuada} />
                        {/* El MOQ va arriba, junto al nombre, y no perdido en la línea gris de
                            abajo: es el dato que decide si esta pieza entra al embarque o no
                            (una arandela de US$0,01 con set de 250 son 250 arandelas). */}
                        <ChipMoq moq={r.moq} costoUsd={r.costoUsd} />
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {r.bajajCode && <span className="font-mono">{r.bajajCode}</span>}
                        {r.altCode && (
                          <span className="ml-1 font-mono text-gray-300" title="El otro código de la misma pieza">
                            / {r.altCode}
                          </span>
                        )}
                        {motos && (
                          <span className="ml-2 text-gray-500" title={motos.lista}>🏍 {motos.n} motos</span>
                        )}
                        {r.costoUsd != null && <span className="ml-2 font-mono text-gray-500">{usd(r.costoUsd)}</span>}
                        {r.moq != null && r.moq > 1 && r.costoUsd != null && (
                          <span className="ml-2 font-mono text-amber-700" title={`${r.moq} × ${usd(r.costoUsd)}`}>
                            {usd(r.costoUsd * r.moq)} el mínimo
                          </span>
                        )}
                        {dims(r.dimL, r.dimA, r.dimH) && (
                          <span className="ml-2 font-mono">{dims(r.dimL, r.dimA, r.dimH)} cm</span>
                        )}
                        {r.sinMedidas && <span className="ml-2 text-amber-600">sin medidas</span>}
                        {yaLlevas > 0 && (
                          <span className="ml-2 font-medium text-cyan-700">ya llevás {yaLlevas} → {yaLlevas + paso}</span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={r.descontinuada}
                      title={r.descontinuada ? 'Bajaj no la fabrica más: no se le puede comprar a ningún proveedor' : undefined}
                      onClick={() => {
                        agregarPiezas([{
                          pieza: {
                            productId: r.id,
                            nameEs: r.nameEs,
                            bajajCode: r.bajajCode,
                            altCode: r.altCode,
                            moq: r.moq,
                            compatibleModels: r.compatibleModels,
                            dimL: r.dimL,
                            dimA: r.dimA,
                            dimH: r.dimH,
                            volumeUnitM3: r.volumeM3,
                            weightUnitKg: r.weightKg,
                            costoUnitUsd: r.costoUsd ?? 0,
                            sinMedidas: r.sinMedidas,
                            descontinuada: r.descontinuada,
                          },
                          cantidad: paso,
                        }])
                        setSearch('')
                      }}
                      className="shrink-0 text-sm bg-blue-600 text-white px-3 py-1 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {r.descontinuada ? 'No se fabrica' : yaLlevas > 0 ? '+1' : paso > 1 ? `Agregar ${paso}` : 'Agregar'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Es mercancía tuya: solo producto y cantidad. El precio de venta sale del catálogo cuando la caja llega.
        </p>
      </div>

      {/* Contenido */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {borrador.length > 0 && (
          <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Contenido del embarque</h2>
            {/* Copia el BORRADOR, no lo guardado: es lo que estás viendo en la tabla de
                abajo, que es lo que uno cree estar copiando. Se avisa cuando difieren. */}
            <CopiarJson
              obtener={() => embarqueAJson({ embarque: nombre, proveedor }, borrador)}
              label={`Copiar JSON (${borrador.length})`}
              title={
                sucio
                  ? 'Copia lo que ves acá abajo, incluidos los cambios sin guardar'
                  : 'Copiar el contenido del embarque como JSON'
              }
              className="shrink-0 border border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors"
            />
          </div>
        )}
        {borrador.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            <p className="text-lg">El embarque está vacío</p>
            <p className="text-sm mt-1">Buscá piezas arriba para empezar a llenarlo.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-semibold">Pieza</th>
                <th className="text-center px-3 py-3 font-semibold w-28">Cant.</th>
                <th className="text-right px-3 py-3 font-semibold" title="L×A×H en cm">Medidas</th>
                <th className="text-right px-3 py-3 font-semibold">m³</th>
                <th className="text-right px-3 py-3 font-semibold">kg</th>
                <th className="text-right px-3 py-3 font-semibold">Costo origen</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {borrador.map(l => (
                <tr key={l.id} className={l.descontinuada ? 'bg-red-50/60' : l.sinMedidas ? 'bg-amber-50/50' : 'hover:bg-gray-50'}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/products/${l.productId}`}
                      className={`hover:text-blue-600 ${l.descontinuada ? 'text-gray-500 line-through' : 'text-gray-900'}`}
                    >
                      {l.nameEs}
                    </Link>
                    <ChipDescontinuada activo={l.descontinuada} />
                    {l.id < 0 && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800">
                        nueva
                      </span>
                    )}
                    {l.bajajCode && <span className="ml-2 font-mono text-xs text-gray-400">{l.bajajCode}</span>}
                    <CodigoAlterno code={l.altCode} />
                    <ChipMoq moq={l.moq} cantidad={l.quantity} />
                    {(() => {
                      const motos = chipMotos(l.compatibleModels)
                      return motos && (
                        <span
                          className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600"
                          title={motos.lista}
                        >
                          🏍 {motos.n} motos
                        </span>
                      )
                    })()}
                    {l.sinMedidas && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                        sin medidas
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {/* value controlado, no defaultValue: la cantidad ahora vive en el
                        borrador y tiene que poder cambiarla también Deshacer. */}
                    <input
                      type="number"
                      min={l.moq && l.moq > 1 ? l.moq : 1}
                      value={l.quantity}
                      disabled={guardando}
                      onChange={e => {
                        const q = parseInt(e.target.value)
                        if (!Number.isFinite(q) || q < 1) return
                        editar(
                          prev => prev.map(x => (x.id === l.id ? { ...x, quantity: q } : x)),
                          `cant:${l.id}`,
                        )
                      }}
                      className={`w-16 border rounded px-2 py-0.5 text-sm text-center ${
                        cumpleMoq(l.quantity, l.moq) ? 'border-gray-200' : 'border-amber-400 bg-amber-50'
                      }`}
                    />
                    {/* El piso del proveedor. Se muestra el número y no un botón que lo
                        aplique: subir a 50 arandelas puede ser la respuesta correcta o el
                        momento de sacar la pieza de la caja. */}
                    {!cumpleMoq(l.quantity, l.moq) && (
                      <p className="text-[10px] text-amber-700 mt-0.5 whitespace-nowrap">
                        mínimo {l.moq} → +{cantidadMinima(l.quantity, l.moq) - l.quantity}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 text-xs">
                    {dims(l.dimL, l.dimA, l.dimH) ?? <span className="text-amber-600">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-700">
                    {l.sinMedidas ? <span className="text-amber-600">—</span> : vol(l.volumeUnitM3 * l.quantity)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-500">
                    {(l.weightUnitKg * l.quantity).toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-700">
                    {usd(l.costoUnitUsd * l.quantity)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={guardando}
                      onClick={() => editar(prev => prev.filter(x => x.id !== l.id))}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                      title="Quitar (se puede deshacer)"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-200 bg-gray-50 text-xs">
                <td className="px-4 py-2 text-gray-500">
                  {borrador.length} línea{borrador.length === 1 ? '' : 's'}
                </td>
                <td className="px-3 py-2 text-center font-mono text-gray-600">
                  {borrador.reduce((s, l) => s + l.quantity, 0)}
                </td>
                <td />
                <td className="px-3 py-2 text-right font-mono text-gray-700">{vol(volumenBorrador)}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-600">
                  {borrador.reduce((s, l) => s + l.weightUnitKg * l.quantity, 0).toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">
                  {usd(borrador.reduce((s, l) => s + l.costoUnitUsd * l.quantity, 0))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Barra de guardado. Pegada abajo y solo cuando hay algo pendiente: mientras esté
          visible, lo que ves en pantalla todavía no está en la base — y "Cerrar embarque"
          cierra lo GUARDADO, no lo que estás mirando. */}
      {(sucio || error || bloqueadas.length > 0) && (
        <div className="sticky bottom-4 z-20">
          <div className={`rounded-xl shadow-lg border px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${
            error || bloqueadas.length > 0 ? 'bg-red-50 border-red-300' : 'bg-white border-amber-300'
          }`}>
            <div className="text-sm min-w-0">
              {bloqueadas.length > 0 ? (
                <>
                  <span className="font-semibold text-red-800">
                    {bloqueadas.length} pieza{bloqueadas.length === 1 ? '' : 's'} descontinuada
                    {bloqueadas.length === 1 ? '' : 's'} en la caja.
                  </span>{' '}
                  <span className="text-red-700">
                    Bajaj no {bloqueadas.length === 1 ? 'la fabrica' : 'las fabrica'} más y no {bloqueadas.length === 1 ? 'la consigue' : 'las consigue'} ningún
                    proveedor: quitalas para poder guardar.
                  </span>
                </>
              ) : error ? (
                <>
                  <span className="font-semibold text-red-800">No se guardó.</span>{' '}
                  <span className="text-red-700">{error}</span>{' '}
                  <span className="text-red-600">Tu armado sigue acá: probá de nuevo.</span>
                </>
              ) : (
                <>
                  <span className="font-semibold text-gray-900">
                    {cambios.total} cambio{cambios.total === 1 ? '' : 's'} sin guardar
                  </span>
                  <span className="text-gray-500">
                    {[
                      cambios.altas && `${cambios.altas} alta${cambios.altas === 1 ? '' : 's'}`,
                      cambios.modificadas && `${cambios.modificadas} cantidad${cambios.modificadas === 1 ? '' : 'es'}`,
                      cambios.bajas && `${cambios.bajas} baja${cambios.bajas === 1 ? '' : 's'}`,
                    ].filter(Boolean).join(' · ')}
                    {cambios.total > 0 && ' — '}
                    el costo de arriba se recalcula al guardar
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={deshacer}
                disabled={historial.length === 0 || guardando}
                title="Deshacer el último cambio"
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ↩ Deshacer{historial.length > 1 ? ` (${historial.length})` : ''}
              </button>
              <button
                type="button"
                onClick={descartar}
                disabled={guardando}
                title="Volver a lo último guardado"
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                Descartar
              </button>
              <button
                type="button"
                onClick={guardar}
                disabled={guardando || pending || bloqueadas.length > 0}
                title={bloqueadas.length > 0 ? 'Hay piezas descontinuadas en la caja' : undefined}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
