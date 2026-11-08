// Cómo se lee el inventario en pantalla (puro, sin DB: lo usan lib/inventario, /inventario y
// check:costeo). Las reglas de qué cuenta como inventario y cómo se valúa están en lib/inventario.

/** Un ensamble donde va la pieza. Las variantes por moto del mismo nombre son uno solo. */
export interface EnsambleDePieza {
  nombre: string
  /** Subgrupo dentro del despiece (el de la primera variante que lo trae). */
  subgrupo: string
  imageUrl: string | null
  /** El texto compatibleModels de cada variante: un ensamble lleva una moto. */
  modelos: string[]
}

// Cada nombre una vez, el más repetido primero: el ensamble de la pieza en casi todas las motos
// ("Rear Axle") va antes que el que aparece en una sola ("Service Kit"). Empate: alfabético.
export function ensamblesDePieza(
  enlaces: { groupName: string; nombre: string; imageUrl: string | null; compatibleModels: string }[],
): EnsambleDePieza[] {
  // 99rpm separa subgrupo y variante con "|" ("Mudguard| Black"): se lee "Mudguard · Black".
  const sub = (g: string) => g.split('|').map(s => s.trim()).filter(Boolean).join(' · ')
  const porNombre = new Map<string, EnsambleDePieza & { n: number }>()
  for (const e of enlaces) {
    const x = porNombre.get(e.nombre)
    if (!x) {
      porNombre.set(e.nombre, { nombre: e.nombre, subgrupo: sub(e.groupName), imageUrl: e.imageUrl, modelos: [e.compatibleModels], n: 1 })
      continue
    }
    x.n++
    x.imageUrl ??= e.imageUrl
    if (!x.subgrupo) x.subgrupo = sub(e.groupName)
    x.modelos.push(e.compatibleModels)
  }
  return [...porNombre.values()]
    .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre))
    .map(({ n: _n, ...e }) => e)
}

/** Lo que se sacaría vendiendo a precio de hoy todo lo que hay y lo que viene, y lo que queda. */
export function margenAPrecioDeHoy(f: {
  aqui: number
  caminoAereo: number
  caminoMaritimo: number
  valorAquiUsd: number | null
  valorCaminoUsd: number
  precioUsd: number | null
}): { costoUsd: number | null; ventaUsd: number | null; margenUsd: number | null } {
  // Un stock negativo es un error de conteo, no mercancía: no se vende ni se valúa.
  const unidades = Math.max(f.aqui, 0) + f.caminoAereo + f.caminoMaritimo
  const costoUsd = f.valorAquiUsd == null ? null : f.valorAquiUsd + f.valorCaminoUsd
  const ventaUsd = f.precioUsd == null ? null : f.precioUsd * unidades
  return { costoUsd, ventaUsd, margenUsd: costoUsd == null || ventaUsd == null ? null : ventaUsd - costoUsd }
}

export const SE_PIERDE = (margenUsd: number | null) => margenUsd != null && margenUsd < -0.005

export interface GrupoEnsamble<F> {
  /** null = piezas que no van en ningún ensamble (accesorios). */
  nombre: string | null
  imageUrl: string | null
  modelos: string[]
  piezas: { fila: F; subgrupo: string }[]
}

// Cada pieza en TODOS los ensambles donde va (como en Nueva venta): buscar por cualquiera la
// encuentra. Arriba el que junta más piezas tuyas; a igualdad, el que está en más motos (un
// despiece de color, "Black (2009-2011) Painted Parts", es de pocas: "Headlamp Fairing" le gana).
// Así los de un solo tornillo quedan al fondo sin excluir ninguno a mano. Una pieza cuenta en
// varios grupos, así que los grupos no suman el total.
export function agruparPorEnsamble<F extends { ensambles: EnsambleDePieza[] }>(filas: F[]): GrupoEnsamble<F>[] {
  const grupos = new Map<string | null, GrupoEnsamble<F>>()
  for (const fila of filas) {
    const destinos = fila.ensambles.length > 0 ? fila.ensambles : [null]
    for (const e of destinos) {
      const clave = e?.nombre ?? null
      let g = grupos.get(clave)
      if (!g) {
        g = { nombre: clave, imageUrl: null, modelos: [], piezas: [] }
        grupos.set(clave, g)
      }
      g.imageUrl ??= e?.imageUrl ?? null
      if (e) g.modelos.push(...e.modelos)
      g.piezas.push({ fila, subgrupo: e?.subgrupo ?? '' })
    }
  }
  return [...grupos.values()].sort((a, b) =>
    (a.nombre == null ? 1 : 0) - (b.nombre == null ? 1 : 0) ||
    b.piezas.length - a.piezas.length ||
    new Set(b.modelos).size - new Set(a.modelos).size ||
    (a.nombre ?? '').localeCompare(b.nombre ?? ''))
}
