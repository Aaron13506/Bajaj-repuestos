import { parseModelos } from '@/lib/modelos'
import { CM3_PER_M3 } from '@/lib/calc'

// ─────────────────────────────────────────────────────────────────────────────
// Copiar un ensamble como JSON.
//
// Formato para sacar un ensamble entero FUERA de la app: pasárselo a un proveedor para que
// cotice, pedirle a una IA las medidas que faltan, o revisarlo en una lista aparte. Un
// objeto por ensamble con sus piezas adentro, porque el ensamble es la unidad con la que se
// piensa la compra: el nombre de una pieza suelta no dice de qué moto es ni para qué sirve.
//
// Los campos llevan los nombres del que lo recibe, no los de la base (`categoria` y no
// `groupName`, `minimo` y no `moq`, `precio` y no `costoUsd`). Esto se pega en otro lado,
// donde nadie conoce nuestro esquema — y una vez pegado, renombrar acá rompe lo de allá.
// ─────────────────────────────────────────────────────────────────────────────

export interface PiezaJson {
  /** Subgrupo dentro del ensamble ("Friction Plates"). */
  categoria: string
  nombre: string
  codigo: string | null
  /** Costo de COMPRA unitario en USD, sin símbolo. `null` cuando no se conoce: un 0 sería
   *  un precio falso, y del otro lado no hay forma de distinguirlo de una pieza gratis. */
  precio: number | null
  /** Nombres reales de las motos, no cantidades: es el dato con el que se decide. */
  compat_modelos: string[]
  /** Volumen de UNA unidad. `null` = sin dimensiones cargadas, que es justamente lo que se
   *  sale a buscar afuera (por mar, sin volumen la pieza no se puede costear). */
  cm3: number | null
  /** Mínimo de compra del proveedor. `null` = no lo declara, que no es lo mismo que 1. */
  minimo: number | null
  /** Cuántas de esta pieza ya van en la caja que se está armando. Un `0` es un dato, no un
   *  faltante — "todavía no llevo ninguna" es justo lo que se viene a leer acá. El campo
   *  entero no aparece cuando el que exporta no está armando ninguna caja: ahí el número
   *  no existe, y un 0 sería una respuesta inventada a una pregunta que nadie hizo. */
  en_caja?: number
  /** Link/id único de la pieza. Hoy siempre `null`: la única URL que tenemos es la del
   *  ensamble en 99rpm, la misma para todas sus piezas, así que no referencia ninguna. */
  url: string | null
}

export interface EnsambleJson {
  modelo: string | null
  ensamble: string
  piezas: PiezaJson[]
}

/** Lo mínimo que necesita una pieza para exportarse — la forma que ya devuelve
 *  `componentesDeEnsamble`, sin atarse a ella. */
export interface PiezaFuente {
  groupName: string
  child: {
    /** `Product.id`. Es la clave con la que se cruza contra lo que ya está en la caja: el
     *  código Bajaj no sirve — hay piezas con dos, y otras sin ninguno. */
    id: number
    nameEs: string
    bajajCode: string | null
    compatibleModels: string | null
    costoUsd: number | null
    moq: number | null
    /** Volumen de una unidad en m³; 0 cuando le faltan dimensiones. */
    volumeM3: number
  }
}

const redondear = (n: number, decimales: number) => {
  const f = 10 ** decimales
  return Math.round(n * f) / f
}

/**
 * Arma el objeto del ensamble. `modelo` explícito gana sobre el del ensamble: cuando se
 * está recorriendo una moto en particular, esa es la que importa aunque el ensamble sirva
 * para varias.
 *
 * `enCaja` (productId → cantidad) anota cada pieza con lo que YA va en la caja que se está
 * armando. Sin eso, el ensamble copiado se lee como si estuviera vacío: los ensambles se
 * pisan entre motos — el mismo SKU aparece en varios despieces — y afuera de la app no hay
 * forma de saber que esa pieza ya se pidió. Se pasa el mapa completo y no un dato por
 * pieza porque la unidad de la respuesta es el ensamble entero, incluidas las piezas que
 * todavía no llevás: ese `0` explícito es la mitad útil de la lista.
 */
export function ensambleAJson(
  ensamble: { nameEs: string; compatibleModels: string | null },
  piezas: PiezaFuente[],
  modelo?: string | null,
  enCaja?: Map<number, number>,
): EnsambleJson {
  return {
    modelo: modelo?.trim() || parseModelos(ensamble.compatibleModels).join(', ') || null,
    ensamble: ensamble.nameEs,
    piezas: piezas.map(p => ({
      categoria: p.groupName || '—',
      nombre: p.child.nameEs,
      codigo: p.child.bajajCode,
      precio: p.child.costoUsd != null ? redondear(p.child.costoUsd, 2) : null,
      compat_modelos: parseModelos(p.child.compatibleModels),
      // m³ → cm³. Se redondea a 2 decimales: un tornillo puede medir menos de 1 cm³ y
      // truncarlo a entero lo dejaría en 0, que se lee como "no ocupa nada".
      cm3: p.child.volumeM3 > 0 ? redondear(p.child.volumeM3 * CM3_PER_M3, 2) : null,
      minimo: p.child.moq,
      ...(enCaja ? { en_caja: enCaja.get(p.child.id) ?? 0 } : {}),
      url: null,
    })),
  }
}
