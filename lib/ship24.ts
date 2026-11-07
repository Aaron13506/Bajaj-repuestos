// Ship24 (Tracking API v1): sigue solo los trackings de la caja, con el courier que sea.
// Docs: https://docs.ship24.com/ (OpenAPI en docs.ship24.com/assets/openapi/ship24-tracking-api.yaml).
//
// Cada tracking de la caja puede llevar el courierCode de Ship24 (delhivery, dtdc, in-post,
// dhl…): con él, pnpm tracking:sync crea su tracker una vez y después copia su estado cada
// hora. Sin él sigue siendo un número anotado, como antes.
//
// Lo que llega es una COPIA de lo que dice el courier, para contestarle al cliente sin abrir
// cinco páginas. No mueve etapas ni toca stock ni plata: la etapa la sigue moviendo el dueño,
// porque "entregado en el depósito" según un courier no es "lo recibí y lo conté".
//
// Por qué consulta (cada hora) y no webhook: la app está detrás de oauth2-proxy + Basic Auth y
// abrirle una ruta pública a un tercero no vale la pena por una caja que tarda semanas.
//
// Cupo: el plan "per-shipment" cuenta trackers creados ("shipments (trackers) … quota"). Crear
// es idempotente con los mismos datos, pero cambiar cualquier campo crea OTRO tracker. Por eso
// se crea solo lo que tiene courier, una vez (trackerId), siempre con los mismos campos
// (`cuerpoTracker`), y lo que dio error no se reintenta solo. Leer los resultados de un tracker
// existente no crea nada.
//
// Este archivo es puro salvo `llamarApi` y las funciones `api*` (fetch). La parte que toca la
// base está en lib/sync-trackings.ts.

export const S24_BASE = 'https://api.ship24.com/public/v1'
export const ENV_API_KEY = 'SHIP24_API_KEY'
// El límite es 10 por segundo por endpoint; se deja aire.
export const S24_PAUSA_MS = 150
// La primera consulta de un número nuevo (POST /trackers/track) puede tardar hasta un minuto.
const TIMEOUT_CREAR_MS = 75_000
const TIMEOUT_MS = 30_000
// La lista de couriers cambia poco: se refresca una vez por semana.
export const COURIERS_VIGENCIA_DIAS = 7

export function apiKeyShip24(): string | null {
  const k = process.env[ENV_API_KEY]?.trim()
  return k ? k : null
}

// ── Estados ──────────────────────────────────────────────────────────────────

// statusMilestone de Ship24 (docs.ship24.com/status), más `detenido`: Ship24 dejó de seguirlo
// (isTracked = false: inactividad o baja) sin que llegara. Lo pone `datosDeTracking`.
export const ESTADOS_S24 = [
  'pending', 'info_received', 'in_transit', 'out_for_delivery', 'failed_attempt',
  'available_for_pickup', 'delivered', 'exception', 'detenido',
] as const
export type EstadoS24 = (typeof ESTADOS_S24)[number]

export const ESTADO_S24_META: Record<EstadoS24, { label: string; icon: string; color: string }> = {
  pending: { label: 'Sin datos aún', icon: '⏳', color: 'bg-gray-100 text-gray-600' },
  info_received: { label: 'Guía creada', icon: '🏷️', color: 'bg-sky-100 text-sky-700' },
  in_transit: { label: 'En tránsito', icon: '🚚', color: 'bg-blue-100 text-blue-700' },
  out_for_delivery: { label: 'En reparto', icon: '📍', color: 'bg-indigo-100 text-indigo-700' },
  failed_attempt: { label: 'Intento fallido', icon: '⚠️', color: 'bg-amber-100 text-amber-700' },
  available_for_pickup: { label: 'Para retirar', icon: '📦', color: 'bg-indigo-100 text-indigo-700' },
  delivered: { label: 'Entregado', icon: '✅', color: 'bg-green-100 text-green-700' },
  exception: { label: 'Problema', icon: '🛑', color: 'bg-red-100 text-red-700' },
  detenido: { label: 'Sin novedades (Ship24 dejó de seguirlo)', icon: '💤', color: 'bg-gray-100 text-gray-500' },
}

export function esEstadoS24(v: unknown): v is EstadoS24 {
  return typeof v === 'string' && (ESTADOS_S24 as readonly string[]).includes(v)
}

export function metaEstado(estado: string | null | undefined) {
  return esEstadoS24(estado) ? ESTADO_S24_META[estado] : null
}

/** Los que ya no van a cambiar: no se vuelven a consultar. */
export const ESTADOS_FINALES = ['delivered', 'detenido'] as const

/**
 * Ya no va a cambiar. `exception` NO es final: Ship24 lo usa también para una devolución en
 * curso, y un paquete retenido en aduana puede seguir.
 */
export function esEstadoFinal(estado: string | null | undefined): boolean {
  return (ESTADOS_FINALES as readonly string[]).includes(estado ?? '')
}

// ── Couriers ─────────────────────────────────────────────────────────────────

export type Courier = { code: string; nombre: string; pais: string | null }

/**
 * El courier de un renglón del formulario. El campo es un buscador sobre la lista de Ship24:
 * lo elegido llega como `codigo`. Texto escrito sin elegir NO se acepta en silencio (un
 * "Delhivry" mal escrito quedaría sin seguimiento sin que nadie lo note): se rechaza, salvo
 * que se haya marcado a propósito `libre` ("anotar sin seguimiento", para Zoom, Tealca o una
 * referencia de Shoppre) o que todavía no haya lista. Un texto que es exactamente el nombre o
 * el code de un solo courier no es un error de tipeo y se acepta.
 */
export function courierDeFila(
  f: { codigo: string | null; libre: boolean; texto: string | null },
  lista: Courier[],
): { courierCode: string | null; transportista: string | null } | { error: string } {
  const codigo = (f.codigo ?? '').trim().toLowerCase()
  const texto = (f.texto ?? '').trim() || null
  if (codigo) {
    const c = lista.find(c => c.code === codigo)
    if (!c) return { error: `el courier «${codigo}» ya no está en la lista de Ship24; elegilo de nuevo.` }
    return { courierCode: c.code, transportista: c.nombre }
  }
  if (!texto || f.libre || lista.length === 0) return { courierCode: null, transportista: texto }
  const c = resolverCourier(texto, lista)
  if (c) return { courierCode: c.code, transportista: c.nombre }
  return { error: `«${texto}» no es un courier de la lista. Elegilo de la lista, o marcá «anotar sin seguimiento».` }
}

/**
 * El nombre exacto si es de un solo courier, si no el code exacto. Sin adivinar: un nombre
 * que tienen dos couriers ("DHL") no se resuelve aunque también sea un code.
 */
export function resolverCourier(texto: string | null, lista: Courier[]): Courier | null {
  const t = (texto ?? '').trim().toLowerCase()
  if (!t || lista.length === 0) return null
  const porNombre = lista.filter(c => c.nombre.toLowerCase() === t)
  if (porNombre.length > 0) return porNombre.length === 1 ? porNombre[0] : null
  return lista.find(c => c.code === t) ?? null
}

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * Los couriers que coinciden con lo que se va escribiendo en el buscador, mejores primero:
 * el nombre empieza así, el code empieza así, el nombre lo contiene, el code lo contiene.
 * Los de India, USA y Venezuela (por donde pasan las cajas) van antes a igual coincidencia.
 */
export function buscarCouriers(q: string, lista: Courier[], max = 8): Courier[] {
  const t = normalizar(q)
  if (!t) return []
  const cerca = new Set(['IN', 'US', 'VE'])
  const puntaje = (c: Courier) => {
    const n = normalizar(c.nombre)
    if (n.startsWith(t)) return 0
    if (c.code.startsWith(t)) return 1
    if (n.includes(t)) return 2
    if (c.code.includes(t)) return 3
    return -1
  }
  return lista
    .map(c => ({ c, p: puntaje(c) }))
    .filter(x => x.p >= 0)
    .sort((a, b) =>
      a.p - b.p ||
      Number(!cerca.has(a.c.pais ?? '')) - Number(!cerca.has(b.c.pais ?? '')) ||
      a.c.nombre.length - b.c.nombre.length ||
      a.c.nombre.localeCompare(b.c.nombre))
    .slice(0, max)
    .map(x => x.c)
}

type CourierCrudo = {
  courierCode?: string | null
  courierName?: string | null
  countryCode?: string | null
  isDeprecated?: boolean | null
}

/**
 * La lista para elegir, de GET /couriers. Los deprecados se dejan afuera: Ship24 ignora su
 * code ("the value will be ignored"), así que elegirlo sería seguir sin courier sin saberlo.
 */
export function listaDeCouriers(crudos: CourierCrudo[]): Courier[] {
  const vistos = new Set<string>()
  const lista: Courier[] = []
  for (const c of crudos) {
    const code = (c.courierCode ?? '').trim().toLowerCase()
    const nombre = (c.courierName ?? '').trim()
    if (!code || !nombre || c.isDeprecated || vistos.has(code)) continue
    vistos.add(code)
    lista.push({ code, nombre, pais: (c.countryCode ?? '').trim().toUpperCase() || null })
  }
  return lista
}

// ── El tracker que se crea ───────────────────────────────────────────────────

// Ship24 acepta 5 a 50 caracteres: letras, números y - _ / .
const NUMERO_S24 = /^[a-zA-Z0-9\-_/.]{5,50}$/

/** El número como lo acepta Ship24: sin espacios (una guía pegada "1234 5678"). */
export function numeroParaShip24(numero: string): string | { error: string } {
  const n = numero.replace(/\s+/g, '')
  if (!NUMERO_S24.test(n)) {
    return { error: 'Ship24 solo sigue números de 5 a 50 caracteres con letras, dígitos y - _ / .' }
  }
  return n
}

// A dónde va cada tramo: Ship24 lo pide para afinar ("recommended to improve tracking
// accuracy") y algunos couriers lo exigen. El local no se manda: un proveedor de China
// despacha en China, y un país inventado empeora la búsqueda.
const DESTINO_TRAMO: Record<string, string | undefined> = { usa: 'US', venezuela: 'VE' }

/**
 * El cuerpo de POST /trackers/track. Siempre el mismo para la misma fila: Ship24 es
 * idempotente con los mismos datos, y cualquier cambio crearía otro tracker (otro shipment
 * del cupo). Por eso no lleva nada que cambie con el tiempo (fechas, notas editables).
 */
export function cuerpoTracker(f: { envioId: number; tramo: string; numero: string; courierCode: string }) {
  const numero = numeroParaShip24(f.numero)
  if (typeof numero !== 'string') return numero
  const destino = DESTINO_TRAMO[f.tramo]
  return {
    trackingNumber: numero,
    courierCode: [f.courierCode],
    shipmentReference: `Caja #${f.envioId} · ${f.tramo}`,
    ...(destino ? { destinationCountryCode: destino } : {}),
  }
}

// ── Respuestas ───────────────────────────────────────────────────────────────

export type Checkpoint = { fecha: string | null; detalle: string; lugar: string | null; estado: string | null }

// Un elemento de data.trackings[], solo lo que se usa. Todo puede venir null.
export type TrackingS24 = {
  tracker?: { trackerId?: string | null; trackingNumber?: string | null; isTracked?: boolean | null } | null
  shipment?: { statusMilestone?: string | null; statusCode?: string | null } | null
  events?: RawEvent[] | null
}
type RawEvent = {
  status?: string | null
  occurrenceDatetime?: string | null
  location?: string | null
  statusMilestone?: string | null
}

const MAX_EVENTOS = 60
const MAX_TEXTO = 500

const corto = (s: string | null | undefined) => {
  const t = (s ?? '').trim()
  return t ? t.slice(0, MAX_TEXTO) : null
}

/**
 * Lo que se guarda de un tracking de Ship24. Los eventos llegan del más nuevo al más viejo
 * (y pueden venir de más de un courier si el paquete cambió de manos); se respeta ese orden.
 */
export function datosDeTracking(t: TrackingS24): {
  trackerId: string | null
  estado: string | null
  subestado: string | null
  ultimoEvento: string | null
  ultimoEventoEn: string | null
  eventos: Checkpoint[]
} {
  const vistos = new Set<string>()
  const eventos: Checkpoint[] = []
  for (const e of t.events ?? []) {
    const detalle = corto(e.status)
    if (!detalle) continue
    const fecha = corto(e.occurrenceDatetime)
    const clave = `${fecha}|${detalle}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    eventos.push({ fecha, detalle, lugar: corto(e.location), estado: corto(e.statusMilestone) })
  }
  const hito = corto(t.shipment?.statusMilestone)?.toLowerCase() ?? null
  // isTracked = false sin haber llegado: Ship24 ya no va a traer nada nuevo.
  const estado = t.tracker?.isTracked === false && hito !== 'delivered' ? 'detenido' : hito
  return {
    trackerId: corto(t.tracker?.trackerId),
    estado,
    subestado: corto(t.shipment?.statusCode),
    ultimoEvento: eventos[0]?.detalle ?? null,
    ultimoEventoEn: eventos[0]?.fecha ?? null,
    eventos: eventos.slice(0, MAX_EVENTOS),
  }
}

/** La columna `eventos` como se guardó (Json): lo que no tenga forma de checkpoint se descarta. */
export function eventosGuardados(v: unknown): Checkpoint[] {
  return Array.isArray(v) ? (v as Checkpoint[]).filter(e => e && typeof e.detalle === 'string') : []
}

/** Cuándo se consultó, en hora de Venezuela: "01/11, 12:15 a. m.". */
export function horaConsulta(d: Date): string {
  return d.toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** "2023-11-04T14:31:00-04:00" → "2023-11-04 14:31". La hora es la del courier, sin convertir. */
export function fechaCourier(s: string | null | undefined): string {
  if (!s) return ''
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : s
}

// ── Errores ──────────────────────────────────────────────────────────────────

// errors[].code de Ship24 que dicen "este tracking no sirve así": se guardan en la fila y no
// se reintentan solos. Los demás (clave, plan, cupo, límite, servidor) cortan la corrida.
const ERRORES_DE_FILA: Record<string, string> = {
  validation_error: 'Ship24 rechazó el número o el courier.',
  parcel_not_found: 'Ship24 no encuentra el paquete con ese courier.',
  shipping_date_outdated: 'Ship24 no sigue envíos de hace más de 6 meses.',
  tracker_not_found: 'El tracker ya no existe en Ship24.',
}

export function errorDeFila(code: string): string | null {
  return ERRORES_DE_FILA[code] ?? null
}

export function mensajeErrorGeneral(status: number, code: string | null, message: string): string {
  if (status === 401) return `Ship24 rechazó la clave (${ENV_API_KEY}).`
  if (code === 'no_active_subscription') return 'La cuenta de Ship24 no tiene un plan activo.'
  if (code === 'quota_limit_reached') return 'Se acabó el cupo de envíos del plan de Ship24 en este período.'
  if (status === 429) return 'Ship24 pidió ir más despacio (429). Se reintenta en la próxima corrida.'
  if (status >= 500) return `Ship24 está con problemas (${status}). Se reintenta en la próxima corrida.`
  return `Ship24 respondió ${status}${code ? ` (${code})` : ''}: ${message}`
}

export class ErrorShip24 extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

type RespuestaS24<T> = { errors?: { code?: string; message?: string }[] | null; data?: T | null }

/**
 * Una llamada a la API. Devuelve el status HTTP, el primer errors[].code (en los 4xx ahí vive
 * el motivo) y data. Solo tira si la red falla o la respuesta no es JSON.
 */
async function llamarApi<T>(
  apiKey: string,
  metodo: 'GET' | 'POST',
  ruta: string,
  { body, timeoutMs = TIMEOUT_MS }: { body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; code: string | null; message: string; data: T | null }> {
  const res = await fetch(`${S24_BASE}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  })
  let json: RespuestaS24<T>
  try {
    json = (await res.json()) as RespuestaS24<T>
  } catch {
    throw new ErrorShip24(res.status, `Ship24 respondió ${res.status} sin JSON.`)
  }
  const err = json.errors?.[0]
  return { status: res.status, code: err?.code ?? null, message: err?.message ?? res.statusText, data: json.data ?? null }
}

/** GET /couriers → la lista para elegir. */
export async function apiCouriers(apiKey: string): Promise<Courier[]> {
  const r = await llamarApi<{ couriers?: CourierCrudo[] }>(apiKey, 'GET', '/couriers')
  if (r.status !== 200 || !Array.isArray(r.data?.couriers)) {
    throw new ErrorShip24(r.status, mensajeErrorGeneral(r.status, r.code, r.message))
  }
  return listaDeCouriers(r.data.couriers)
}

/** Un motivo de la fila, o tira ErrorShip24 (corta la corrida). */
function errorDeRespuesta(r: { status: number; code: string | null; message: string }): { error: string } {
  const deFila = r.code ? errorDeFila(r.code) : null
  if (deFila && r.status < 500) return { error: r.message && r.message !== deFila ? `${deFila} (${r.message})` : deFila }
  throw new ErrorShip24(r.status, mensajeErrorGeneral(r.status, r.code, r.message))
}

/**
 * POST /trackers/track: crea el tracker (si ya existía con los mismos datos devuelve el mismo)
 * y responde ya con su estado. `error` es un motivo de la fila.
 */
export async function apiRegistrar(
  apiKey: string,
  cuerpo: Exclude<ReturnType<typeof cuerpoTracker>, { error: string }>,
): Promise<{ tracking: TrackingS24 } | { error: string }> {
  const r = await llamarApi<{ trackings?: TrackingS24[] }>(apiKey, 'POST', '/trackers/track', {
    body: cuerpo,
    timeoutMs: TIMEOUT_CREAR_MS,
  })
  const t = r.data?.trackings?.[0]
  if (r.status >= 200 && r.status < 300 && t?.tracker?.trackerId) return { tracking: t }
  return errorDeRespuesta(r)
}

/** GET /trackers/{trackerId}/results: el estado de un tracker ya creado (no crea otro). */
export async function apiConsultar(apiKey: string, trackerId: string): Promise<{ tracking: TrackingS24 } | { error: string }> {
  const r = await llamarApi<{ trackings?: TrackingS24[] }>(apiKey, 'GET', `/trackers/${encodeURIComponent(trackerId)}/results`)
  const t = r.data?.trackings?.[0]
  if (r.status === 200 && t) return { tracking: t }
  return errorDeRespuesta(r)
}
