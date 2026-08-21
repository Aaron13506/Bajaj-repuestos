// ─────────────────────────────────────────────────────────────────────────────
// Chequeo físico de peso y dimensiones.
//
// El prompt (lib/prompts.ts, PASO 5) ya le pide a la IA que verifique la densidad
// implícita antes de entregar. Esto es lo mismo pero del lado del código, y hace falta
// por una razón sola: hasta ahora nadie lo verificaba. El prompt PIDE, el cargador
// ACEPTABA. Un alerón cargado con 1 gramo pasó derecho al catálogo, se costeó, se le
// puso precio y se vendió — y no lo detectó nada porque todo lo demás cerraba.
//
// La densidad implícita es el único invariante que se puede chequear sin saber nada de
// la pieza: peso ÷ volumen no puede dar más que el material del que está hecha. Es un
// chequeo grosero a propósito — no busca precisión, busca lo IMPOSIBLE, que es lo que
// una alucinación produce y una investigación honesta no.
//
// Vive aparte de lib/measures.ts para que lo usen los dos lados: el cargador, que
// rechaza antes de escribir, y la auditoría, que revisa lo que ya está guardado.
// ─────────────────────────────────────────────────────────────────────────────

export interface Medidas {
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
}

// 'error' = no se escribe. Es físicamente imposible, así que no hay caso borde en el que
// sea correcto: escribirlo es garantizar un costo mal calculado.
// 'aviso'  = se escribe pero se reporta. Es raro, no imposible.
export type Severidad = 'error' | 'aviso'

export interface Chequeo {
  severidad: Severidad
  codigo: string
  mensaje: string
}

// Acero 7,8 g/cm³ — el material más denso que aparece en una moto. Se deja 8 como techo
// porque una pieza maciza mecanizada puede rozarlo y el redondeo de las dimensiones no
// tiene por qué ser exacto.
export const DENSIDAD_MAX = 8
// Por debajo de esto no hay repuesto: es más liviano que el telgopor (0,03). O el peso
// está en la unidad equivocada, o la caja se infló diez veces.
export const DENSIDAD_MIN = 0.02
// Ninguna pieza viaja de más de un metro: los cables y fundas van enrollados, y medirlos
// estirados multiplica el flete (ver PASO 4 del prompt).
export const DIM_MAX_CM = 100

// Umbrales de AVISO, calibrados contra la distribución real del catálogo (394 piezas
// medidas: mediana 0,44 · p95 4,0 · máximo 7,89 g/cm³). Están puestos donde empieza la
// cola, no donde empieza lo raro: un aviso que salta en el 10% de las filas no se lee, y
// un chequeo que no se lee no chequea nada. Las juntas planas y los o-rings viven
// legítimamente entre 0,03 y 0,08, así que ese tramo NO avisa.
export const AVISO_DENSIDAD_ALTA = 5
export const AVISO_DENSIDAD_BAJA = 0.05

export function densidad(m: Medidas): number | null {
  if (!m.weightGrams || !m.dimL || !m.dimA || !m.dimH) return null
  const cm3 = m.dimL * m.dimA * m.dimH
  return cm3 > 0 ? m.weightGrams / cm3 : null
}

/**
 * Revisa un juego de medidas ya completo (peso + las tres dimensiones). Devuelve la
 * lista de problemas; vacía = pasa. Los campos que faltan NO son un problema acá: que
 * una pieza esté a medio cargar lo reporta la pantalla que la necesita, no este chequeo.
 */
export function chequearMedidas(m: Medidas): Chequeo[] {
  const out: Chequeo[] = []
  const dims = [m.dimL, m.dimA, m.dimH]

  // Un 0 no es "no sé": es un dato afirmando que la pieza no pesa o no ocupa nada. Sin
  // volumen el flete marítimo da 0 y la pieza aparece como una ganga que no existe.
  if (m.weightGrams != null && m.weightGrams <= 0) {
    out.push({ severidad: 'error', codigo: 'peso-cero', mensaje: 'Peso 0 o negativo.' })
  }
  if (dims.some(d => d != null && d <= 0)) {
    out.push({ severidad: 'error', codigo: 'dim-cero', mensaje: 'Alguna dimensión es 0 o negativa.' })
  }

  const d = densidad(m)
  if (d != null) {
    if (d > DENSIDAD_MAX) {
      out.push({
        severidad: 'error',
        codigo: 'densidad-alta',
        mensaje: `Densidad implícita ${d.toFixed(2)} g/cm³ — más que el acero macizo (7,8). Casi siempre es el peso mal leído (kg tomados como g) o dimensiones de menos.`,
      })
    } else if (d < DENSIDAD_MIN) {
      out.push({
        severidad: 'error',
        codigo: 'densidad-baja',
        mensaje: `Densidad implícita ${d.toFixed(3)} g/cm³ — más liviano que el telgopor. O el peso está en la unidad equivocada, o la caja está inflada.`,
      })
    } else if (d > AVISO_DENSIDAD_ALTA) {
      out.push({
        severidad: 'aviso',
        codigo: 'densidad-alta-plausible',
        mensaje: `Densidad ${d.toFixed(2)} g/cm³: solo válida si la pieza es acero macizo sin nada de empaque.`,
      })
    } else if (d < AVISO_DENSIDAD_BAJA) {
      out.push({
        severidad: 'aviso',
        codigo: 'densidad-baja-plausible',
        mensaje: `Densidad ${d.toFixed(3)} g/cm³: normal en un plástico hueco grande o una junta plana, sospechoso en cualquier otra cosa.`,
      })
    }
  }

  // El cubo perfecto es el valor por defecto de los formularios de envío, no una medida.
  if (m.dimL && m.dimA && m.dimH && m.dimL === m.dimA && m.dimA === m.dimH) {
    out.push({
      severidad: 'aviso',
      codigo: 'cubo',
      mensaje: `Cubo perfecto ${m.dimL}×${m.dimA}×${m.dimH}: es el placeholder típico de los formularios.`,
    })
  }

  const larga = dims.find(x => x != null && x > DIM_MAX_CM)
  if (larga != null) {
    out.push({
      severidad: 'aviso',
      codigo: 'dim-larga',
      mensaje: `${larga} cm de lado. Los cables y fundas viajan ENROLLADOS — medirlos estirados multiplica el flete.`,
    })
  }

  // No hay chequeo de "peso mínimo": un o-ring de 2 g es correcto y era el aviso que más
  // ruido hacía. El peso de juguete que sí importa —el alerón de 1 g— lo agarra la
  // densidad, que es el mismo dato mirado contra el tamaño de la pieza.

  return out
}

export const hayError = (cs: Chequeo[]) => cs.some(c => c.severidad === 'error')
