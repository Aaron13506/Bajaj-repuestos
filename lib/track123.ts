// Track123 (Tracking API v2.1): sigue solo los trackings de la caja, con el courier que sea.
// Docs: https://docs.track123.com/reference/request (y /reference/<página>.md da el OpenAPI).
//
// Cada tracking de la caja puede llevar el courierCode de Track123 (delhivery, dtdc, dhl…): con
// él, pnpm tracking:sync lo registra una vez y después copia su estado cada hora. Sin él sigue
// siendo un número anotado, como antes.
//
// Lo que llega es una COPIA de lo que dice el courier, para contestarle al cliente sin abrir
// cinco páginas. No mueve etapas ni toca stock ni plata: la etapa la sigue moviendo el dueño,
// porque "entregado en el depósito" según un courier no es "lo recibí y lo conté".
//
// Por qué consulta (cada hora) y no webhook: la app está detrás de oauth2-proxy + Basic Auth y
// abrirle una ruta pública a un tercero no vale la pena por una caja que tarda semanas.
//
// Cupo: cada número registrado (POST /track/import) gasta uno del plan; consultar
// (POST /track/query) no gasta. Un número se identifica por número + courier: registrar otra vez
// el mismo lo rechaza. Por eso primero se consulta y solo se registra lo que Track123 no tiene,
// solo con courier, y lo que dio error no se reintenta solo.
//
// Este archivo es puro salvo `llamarApi` y las funciones `api*` (fetch). La parte que toca la
// base está en lib/sync-trackings.ts.

export const T123_BASE = 'https://api.track123.com/gateway/open-api/tk/v2.1'
export const ENV_API_KEY = 'TRACK123_API_KEY'
// El límite es 5 por segundo por endpoint; se deja aire.
export const T123_PAUSA_MS = 300
// Hasta 100 números por llamada, tanto para registrar como para consultar.
export const T123_LOTE = 100
const TIMEOUT_MS = 60_000
// La lista de couriers cambia poco: se refresca una vez por semana.
export const COURIERS_VIGENCIA_DIAS = 7

export function apiKeyTrack123(): string | null {
  const k = process.env[ENV_API_KEY]?.trim()
  return k ? k : null
}

// ── Estados ──────────────────────────────────────────────────────────────────

// El vocabulario propio de `EnvioTracking.estado` (lo usan también One Way Cargo y el inicio).
// `detenido`: el servicio dejó de seguirlo sin que llegara.
export const ESTADOS = [
  'pending', 'info_received', 'in_transit', 'out_for_delivery', 'failed_attempt',
  'available_for_pickup', 'delivered', 'exception', 'detenido',
] as const
export type Estado = (typeof ESTADOS)[number]

export const ESTADO_META: Record<Estado, { label: string; icon: string; color: string }> = {
  pending: { label: 'Sin datos aún', icon: '⏳', color: 'bg-gray-100 text-gray-600' },
  info_received: { label: 'Guía creada', icon: '🏷️', color: 'bg-sky-100 text-sky-700' },
  in_transit: { label: 'En tránsito', icon: '🚚', color: 'bg-blue-100 text-blue-700' },
  out_for_delivery: { label: 'En reparto o para retirar', icon: '📍', color: 'bg-indigo-100 text-indigo-700' },
  failed_attempt: { label: 'Intento fallido', icon: '⚠️', color: 'bg-amber-100 text-amber-700' },
  available_for_pickup: { label: 'Para retirar', icon: '📦', color: 'bg-indigo-100 text-indigo-700' },
  delivered: { label: 'Entregado', icon: '✅', color: 'bg-green-100 text-green-700' },
  exception: { label: 'Problema', icon: '🛑', color: 'bg-red-100 text-red-700' },
  detenido: { label: 'Sin novedades (dejó de seguirse)', icon: '💤', color: 'bg-gray-100 text-gray-500' },
}

export function esEstado(v: unknown): v is Estado {
  return typeof v === 'string' && (ESTADOS as readonly string[]).includes(v)
}

export function metaEstado(estado: string | null | undefined) {
  return esEstado(estado) ? ESTADO_META[estado] : null
}

/** Los que ya no van a cambiar: no se vuelven a consultar. */
export const ESTADOS_FINALES = ['delivered', 'detenido'] as const

/**
 * Ya no va a cambiar. `exception` NO es final: cubre una devolución en curso, y un paquete
 * retenido en aduana puede seguir.
 */
export function esEstadoFinal(estado: string | null | undefined): boolean {
  return (ESTADOS_FINALES as readonly string[]).includes(estado ?? '')
}

// transitStatus de Track123 (docs.track123.com/reference/package-status). Los sub-estados
// (IN_TRANSIT_01…) llevan el estado delante. EXPIRED = 30 días sin datos desde que se registró:
// Track123 ya no lo sigue.
const ESTADO_DE_T123: Record<string, Estado> = {
  INIT: 'pending',
  NO_RECORD: 'pending',
  INFO_RECEIVED: 'info_received',
  IN_TRANSIT: 'in_transit',
  WAITING_DELIVERY: 'out_for_delivery',
  DELIVERY_FAILED: 'failed_attempt',
  ABNORMAL: 'exception',
  DELIVERED: 'delivered',
  EXPIRED: 'detenido',
}

/** "IN_TRANSIT" o "IN_TRANSIT_01" → in_transit. Desconocido → null. */
export function estadoDeT123(s: string | null | undefined): Estado | null {
  return ESTADO_DE_T123[(s ?? '').trim().toUpperCase().replace(/_\d+$/, '')] ?? null
}

// ── Couriers ─────────────────────────────────────────────────────────────────

export type Courier = { code: string; nombre: string }

/**
 * El courier de un renglón del formulario. El campo es un buscador sobre la lista de Track123:
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
    if (!c) return { error: `el courier «${codigo}» ya no está en la lista de Track123; elegilo de nuevo.` }
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
 */
export function buscarCouriers(q: string, lista: Courier[], max = 8): Courier[] {
  const t = normalizar(q)
  if (!t) return []
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
    .sort((a, b) => a.p - b.p || a.c.nombre.length - b.c.nombre.length || a.c.nombre.localeCompare(b.c.nombre))
    .slice(0, max)
    .map(x => x.c)
}

type CourierCrudo = { courierCode?: string | null; courierNameEN?: string | null }

/** La lista para elegir, de GET /courier/list: sin repetidos ni vacíos. */
export function listaDeCouriers(crudos: CourierCrudo[]): Courier[] {
  const vistos = new Set<string>()
  const lista: Courier[] = []
  for (const c of crudos) {
    const code = (c.courierCode ?? '').trim().toLowerCase()
    const nombre = (c.courierNameEN ?? '').trim()
    if (!code || !nombre || vistos.has(code)) continue
    vistos.add(code)
    lista.push({ code, nombre })
  }
  return lista
}

// ── Lo que se registra ───────────────────────────────────────────────────────

// 5 a 50 caracteres: letras, números y - _ / . (un número fuera de eso es un error de carga).
const NUMERO_VALIDO = /^[a-zA-Z0-9\-_/.]{5,50}$/

/** El número como se manda: sin espacios (una guía pegada "1234 5678"). */
export function numeroParaTrack123(numero: string): string | { error: string } {
  const n = numero.replace(/\s+/g, '')
  if (!NUMERO_VALIDO.test(n)) {
    return { error: 'Solo se siguen números de 5 a 50 caracteres con letras, dígitos y - _ / .' }
  }
  return n
}

// A dónde va cada tramo: algunos couriers lo necesitan para encontrarlo. El local no se manda:
// un proveedor de China despacha en China, y un país inventado empeora la búsqueda.
const DESTINO_TRAMO: Record<string, string | undefined> = { usa: 'US', venezuela: 'VE' }

/**
 * Un elemento del cuerpo de POST /track/import. La referencia va en `remark`, no en `orderNo`:
 * Track123 rechaza un orderNo repetido, y una caja tiene varios números por tramo.
 */
export function cuerpoRegistro(f: { envioId: number; tramo: string; numero: string; courierCode: string }) {
  const numero = numeroParaTrack123(f.numero)
  if (typeof numero !== 'string') return numero
  const destino = DESTINO_TRAMO[f.tramo]
  return {
    trackNo: numero,
    courierCode: f.courierCode,
    remark: `Caja #${f.envioId} · ${f.tramo}`,
    ...(destino ? { country: destino } : {}),
  }
}
export type CuerpoRegistro = Exclude<ReturnType<typeof cuerpoRegistro>, { error: string }>

/** Cómo se cruza una respuesta con lo pedido: el número, sin importar mayúsculas. */
export const claveNumero = (trackNo: string | null | undefined) => (trackNo ?? '').trim().toUpperCase()

// ── Respuestas ───────────────────────────────────────────────────────────────

export type Checkpoint = { fecha: string | null; detalle: string; lugar: string | null; estado: string | null }

type RawEvent = {
  address?: string | null
  eventTime?: string | null
  eventTimeZeroUTC?: string | null
  timezone?: string | null
  eventDetail?: string | null
  transitSubStatus?: string | null
}
// Un elemento de data.accepted.content[] de /track/query, solo lo que se usa. Todo puede venir null.
export type TrackingT123 = {
  id?: string | null
  trackNo?: string | null
  transitStatus?: string | null
  transitSubStatus?: string | null
  localLogisticsInfo?: { trackingDetails?: RawEvent[] | null } | null
  lastMileInfo?: { openApiWayBillInfo?: { trackingDetails?: RawEvent[] | null } | null } | null
}

const MAX_EVENTOS = 60
const MAX_TEXTO = 500

const corto = (s: string | null | undefined) => {
  const t = (s ?? '').trim()
  return t ? t.slice(0, MAX_TEXTO) : null
}

/** "2022-06-01 19:50:20" + "+08:00" → "2022-06-01T19:50:20+08:00": la hora del courier, con su zona. */
function fechaEvento(e: RawEvent): string | null {
  const t = corto(e.eventTime)
  if (!t) return null
  const zona = (e.timezone ?? '').trim()
  return `${t.replace(' ', 'T')}${/^[+-]\d{2}:\d{2}$/.test(zona) ? zona : ''}`
}

/**
 * Lo que se guarda de un tracking de Track123. Junta los eventos del courier principal y los
 * de última milla (si el paquete cambió de manos), sin repetidos, del más nuevo al más viejo.
 */
export function datosDeTracking(t: TrackingT123): {
  trackerId: string | null
  estado: string | null
  subestado: string | null
  ultimoEvento: string | null
  ultimoEventoEn: string | null
  eventos: Checkpoint[]
} {
  const crudos = [...(t.localLogisticsInfo?.trackingDetails ?? []), ...(t.lastMileInfo?.openApiWayBillInfo?.trackingDetails ?? [])]
  const vistos = new Set<string>()
  const eventos: (Checkpoint & { utc: string })[] = []
  for (const e of crudos) {
    const detalle = corto(e.eventDetail)
    if (!detalle) continue
    const fecha = fechaEvento(e)
    const clave = `${fecha}|${detalle}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    eventos.push({ fecha, detalle, lugar: corto(e.address), estado: estadoDeT123(e.transitSubStatus), utc: (e.eventTimeZeroUTC ?? '').trim() })
  }
  // eventTimeZeroUTC es ISO en UTC: se ordena como texto. Sin hora va al final (sort estable).
  eventos.sort((a, b) => (b.utc || '').localeCompare(a.utc || ''))
  const limpios = eventos.map(({ utc: _, ...e }) => e)
  return {
    trackerId: corto(t.id),
    estado: estadoDeT123(t.transitStatus),
    subestado: corto(t.transitSubStatus),
    ultimoEvento: limpios[0]?.detalle ?? null,
    ultimoEventoEn: limpios[0]?.fecha ?? null,
    eventos: limpios.slice(0, MAX_EVENTOS),
  }
}

/** La columna `eventos` como se guardó (Json): lo que no tenga forma de checkpoint se descarta. */
export function eventosGuardados(v: unknown): Checkpoint[] {
  return Array.isArray(v) ? (v as Checkpoint[]).filter(e => e && typeof e.detalle === 'string') : []
}

/**
 * La identidad de un evento: `fecha|detalle`, la misma clave con la que datosDeTracking quita
 * duplicados. CLAVE_ULTIMO_EVENTO (lib/novedades.ts) la arma igual en SQL; cambiar las dos juntas.
 */
export function claveEvento(e: { fecha: string | null; detalle: string }): string {
  return `${e.fecha ?? ''}|${e.detalle}`
}

/**
 * Qué trajo un tracking desde el último evento que se vio en el inicio. Null = nada nuevo.
 * Se compara por identidad del evento, no por hora: la hora es la del courier (a veces sin
 * zona) y la sincronización la trae una hora después, así que una comparación de fechas
 * escondería un evento que llegó tarde. Si el evento visto sigue en la lista: cuántos llegaron
 * después y su estado (`antes`); si no (nunca se vio o ya no está), los dos van en null.
 */
export function novedadDeTracking(eventos: Checkpoint[], visto: string | null): { nuevos: number | null; antes: string | null } | null {
  if (eventos.length === 0 || claveEvento(eventos[0]) === visto) return null
  const i = visto == null ? -1 : eventos.findIndex(e => claveEvento(e) === visto)
  return i > 0 ? { nuevos: i, antes: eventos[i].estado } : { nuevos: null, antes: null }
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

// `code` de servicio de Track123 (docs.track123.com/reference/status-code). Los de una fila
// rechazada (data.rejected[].error) se guardan en la fila y no se reintentan solos; los de la
// respuesta entera (clave, límite, servidor) cortan la corrida.
export function mensajeErrorGeneral(status: number, code: string | null, message: string): string {
  if (code && /^A02|^A03/.test(code)) return `Track123 rechazó la clave (${ENV_API_KEY}): ${message}`
  if (code === 'A0706' || code === 'B0210') return 'Track123 pidió ir más despacio. Se reintenta en la próxima corrida.'
  if (status >= 500 || (code ?? '').startsWith('B')) return `Track123 está con problemas (${code ?? status}). Se reintenta en la próxima corrida.`
  return `Track123 respondió ${status}${code ? ` (${code})` : ''}: ${message}`
}

export class ErrorTrack123 extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** El motivo de una fila rechazada, para guardarlo. */
export function errorDeFila(e: { code?: string | null; msg?: string | null } | null | undefined): string {
  const msg = (e?.msg ?? '').trim()
  return `Track123 no lo acepta${e?.code ? ` (${e.code})` : ''}${msg ? `: ${msg}` : '.'}`
}

// ── API ──────────────────────────────────────────────────────────────────────

type Rechazo = { trackNo?: string | null; error?: { code?: string | null; msg?: string | null } | null }

/**
 * Una llamada a la API. Tira ErrorTrack123 si la respuesta entera no es un éxito (HTTP o
 * `code` distinto de 00000), y si la red falla. Devuelve data.
 */
async function llamarApi<T>(apiKey: string, metodo: 'GET' | 'POST', ruta: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`${T123_BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Track123-Api-Secret': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  let json: { code?: string | null; msg?: string | null; data?: T | null }
  try {
    json = await res.json()
  } catch {
    throw new ErrorTrack123(res.status, `Track123 respondió ${res.status} sin JSON.`)
  }
  if (res.status !== 200 || json.code !== '00000') {
    throw new ErrorTrack123(res.status, mensajeErrorGeneral(res.status, json.code ?? null, json.msg ?? res.statusText))
  }
  return json.data ?? null
}

/** GET /courier/list → la lista para elegir. */
export async function apiCouriers(apiKey: string): Promise<Courier[]> {
  const data = await llamarApi<CourierCrudo[]>(apiKey, 'GET', '/courier/list')
  if (!Array.isArray(data)) throw new ErrorTrack123(200, 'Track123 devolvió la lista de couriers sin datos.')
  return listaDeCouriers(data)
}

/**
 * POST /track/import con hasta 100 números. Devuelve los rechazados (por claveNumero) con su
 * motivo; el resto quedó registrado.
 */
export async function apiRegistrar(apiKey: string, cuerpos: CuerpoRegistro[]): Promise<Map<string, string>> {
  const data = await llamarApi<{ rejected?: Rechazo[] | null }>(apiKey, 'POST', '/track/import', cuerpos)
  return new Map((data?.rejected ?? []).map(r => [claveNumero(r.trackNo), errorDeFila(r.error)]))
}

/**
 * POST /track/query con hasta 100 números ya registrados (no gasta cupo). Devuelve lo que
 * Track123 tiene, por claveNumero; lo que no tiene, no está.
 */
export async function apiConsultar(apiKey: string, numeros: { trackNo: string; courierCode: string }[]): Promise<Map<string, TrackingT123>> {
  const data = await llamarApi<{ accepted?: { content?: TrackingT123[] | null } | null }>(apiKey, 'POST', '/track/query', {
    trackNoInfos: numeros,
    queryPageSize: T123_LOTE,
  })
  return new Map((data?.accepted?.content ?? []).map(t => [claveNumero(t.trackNo), t]))
}
