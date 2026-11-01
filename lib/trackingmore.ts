// TrackingMore (API v4): sigue solo los trackings de la caja, con el courier que sea.
//
// Cada tracking de la caja puede llevar el courier_code de TrackingMore (Delhivery, DTDC,
// India Post, DHL, Aramex…): con él, pnpm tracking:sync lo registra una vez y después copia
// su estado cada hora. Sin él sigue siendo un número anotado, como antes.
//
// Lo que llega es una COPIA de lo que dice el courier, para contestarle al cliente sin abrir
// cinco páginas. No mueve etapas ni toca stock ni plata: la etapa la sigue moviendo el dueño,
// porque "entregado en el depósito" según un courier no es "lo recibí y lo conté".
//
// Por qué consulta (cada hora) y no webhook: la app está detrás de oauth2-proxy + Basic Auth,
// y abrirle un hueco a TrackingMore expone una ruta pública cuya firma solo cubre el
// Timestamp (HMAC del timestamp, no del cuerpo): cualquiera que vea un aviso puede reusar su
// firma con otro cuerpo. Una caja tarda semanas; una hora de atraso no le cambia nada.
//
// Créditos: TrackingMore cobra uno por cada par número + courier registrado, y no los
// devuelve al borrar. Consultar lo ya registrado es gratis. Por eso se registra solo lo que
// tiene courier, una vez (tmId), y lo que dio error no se reintenta solo.
//
// Este archivo es puro salvo `llamarApi` y las funciones `api*` (fetch). La parte que toca la
// base está en lib/sync-trackings.ts.

export const TM_BASE = 'https://api.trackingmore.com/v4'
export const ENV_API_KEY = 'TRACKINGMORE_API_KEY'
// Hasta 40 números por consulta (GET /trackings/get).
export const TM_LOTE = 40
// POST /trackings/create admite 3 por segundo; se deja aire.
export const TM_PAUSA_CREATE_MS = 400
// La lista de couriers cambia poco: se refresca una vez por semana.
export const COURIERS_VIGENCIA_DIAS = 7

export function apiKeyTrackingMore(): string | null {
  const k = process.env[ENV_API_KEY]?.trim()
  return k ? k : null
}

// ── Estados ──────────────────────────────────────────────────────────────────

export const ESTADOS_TM = [
  'pending', 'notfound', 'inforeceived', 'transit', 'pickup', 'undelivered', 'delivered', 'exception', 'expired',
] as const
export type EstadoTM = (typeof ESTADOS_TM)[number]

export const ESTADO_TM_META: Record<EstadoTM, { label: string; icon: string; color: string }> = {
  pending: { label: 'Sin datos aún', icon: '⏳', color: 'bg-gray-100 text-gray-600' },
  notfound: { label: 'Sin datos aún', icon: '⏳', color: 'bg-gray-100 text-gray-600' },
  inforeceived: { label: 'Guía creada', icon: '🏷️', color: 'bg-sky-100 text-sky-700' },
  transit: { label: 'En tránsito', icon: '🚚', color: 'bg-blue-100 text-blue-700' },
  pickup: { label: 'En reparto', icon: '📍', color: 'bg-indigo-100 text-indigo-700' },
  undelivered: { label: 'Intento fallido', icon: '⚠️', color: 'bg-amber-100 text-amber-700' },
  delivered: { label: 'Entregado', icon: '✅', color: 'bg-green-100 text-green-700' },
  exception: { label: 'Problema', icon: '🛑', color: 'bg-red-100 text-red-700' },
  expired: { label: 'Sin novedades (vencido)', icon: '💤', color: 'bg-gray-100 text-gray-500' },
}

export function esEstadoTM(v: unknown): v is EstadoTM {
  return typeof v === 'string' && (ESTADOS_TM as readonly string[]).includes(v)
}

export function metaEstadoTM(estado: string | null | undefined) {
  return esEstadoTM(estado) ? ESTADO_TM_META[estado] : null
}

/**
 * Ya no va a cambiar: no se vuelve a consultar. `expired` es que el courier no dice nada hace
 * 30 días (TrackingMore deja de seguirlo). `exception` NO es final: un paquete retenido en
 * aduana puede seguir.
 */
export function esEstadoFinal(estado: string | null | undefined): boolean {
  return estado === 'delivered' || estado === 'expired'
}

// ── Couriers ─────────────────────────────────────────────────────────────────

export type CourierTM = { code: string; nombre: string; pais: string | null }

/** Lo que se ve y se elige en el campo transportista: "Delhivery (delhivery)". */
export function etiquetaCourier(c: { code: string; nombre: string }): string {
  return `${c.nombre} (${c.code})`
}

/**
 * Qué courier de TrackingMore quiso decir el texto del campo transportista: la etiqueta de la
 * lista ("Delhivery (delhivery)"), el nombre exacto si es de uno solo, o el code pelado. Si no
 * es ninguno, el texto queda como nota y el tracking solo anotado (null). Sin adivinar: un
 * nombre que tienen dos couriers no se resuelve.
 */
export function resolverCourier(texto: string | null, lista: CourierTM[]): CourierTM | null {
  const t = (texto ?? '').trim()
  if (!t || lista.length === 0) return null
  const porCode = new Map(lista.map(c => [c.code, c]))
  const m = t.match(/\(([a-z0-9-]+)\)\s*$/i)
  if (m) {
    const c = porCode.get(m[1].toLowerCase())
    if (c) return c
  }
  // El nombre manda sobre el code: "DHL" es el nombre de dos couriers y no se resuelve,
  // aunque también sea el code de DHL Express.
  const porNombre = lista.filter(c => c.nombre.toLowerCase() === t.toLowerCase())
  if (porNombre.length > 0) return porNombre.length === 1 ? porNombre[0] : null
  return porCode.get(t.toLowerCase()) ?? null
}

/** La fila del formulario con su courier resuelto: transportista pasa a ser el nombre. */
export function conCourier<F extends { transportista: string | null }>(
  fila: F,
  lista: CourierTM[],
): F & { courierCode: string | null } {
  const c = resolverCourier(fila.transportista, lista)
  return c ? { ...fila, transportista: c.nombre, courierCode: c.code } : { ...fila, courierCode: null }
}

/** Lo que se pone en el campo al editar: la etiqueta si tiene courier, si no el texto. */
export function textoTransportista(t: { transportista: string | null; courierCode: string | null }): string {
  if (t.courierCode) return etiquetaCourier({ code: t.courierCode, nombre: t.transportista ?? t.courierCode })
  return t.transportista ?? ''
}

// ── Respuestas ───────────────────────────────────────────────────────────────

export type CheckpointTM = { fecha: string | null; detalle: string; lugar: string | null; estado: string | null }

// El objeto Tracking de la API, solo lo que se usa. Todo puede venir null.
export type TrackingTM = {
  id?: string | null
  tracking_number?: string | null
  courier_code?: string | null
  delivery_status?: string | null
  substatus?: string | null
  latest_event?: string | null
  latest_checkpoint_time?: string | null
  origin_info?: { trackinfo?: RawCheckpoint[] | null } | null
  destination_info?: { trackinfo?: RawCheckpoint[] | null } | null
}
type RawCheckpoint = {
  checkpoint_date?: string | null
  tracking_detail?: string | null
  location?: string | null
  checkpoint_delivery_status?: string | null
}

const MAX_EVENTOS = 60
const MAX_TEXTO = 500

const corto = (s: string | null | undefined) => {
  const t = (s ?? '').trim()
  return t ? t.slice(0, MAX_TEXTO) : null
}

/**
 * Lo que se guarda de un Tracking de TrackingMore. Los checkpoints del origen y del destino
 * (un envío internacional por correo trae los dos) van juntos, del más nuevo al más viejo.
 */
export function datosDeTracking(t: TrackingTM): {
  tmId: string | null
  estado: string | null
  subestado: string | null
  ultimoEvento: string | null
  ultimoEventoEn: string | null
  eventos: CheckpointTM[]
} {
  const crudos = [...(t.origin_info?.trackinfo ?? []), ...(t.destination_info?.trackinfo ?? [])]
  const vistos = new Set<string>()
  const eventos: CheckpointTM[] = []
  for (const c of crudos) {
    const detalle = corto(c.tracking_detail)
    if (!detalle) continue
    const fecha = corto(c.checkpoint_date)
    const clave = `${fecha}|${detalle}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    eventos.push({ fecha, detalle, lugar: corto(c.location), estado: corto(c.checkpoint_delivery_status) })
  }
  // Las fechas son ISO (a veces con zona, a veces sin): comparar el texto ordena bien dentro
  // del mismo courier, que es lo que hay en una lista.
  eventos.sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? ''))
  return {
    tmId: corto(t.id),
    estado: corto(t.delivery_status)?.toLowerCase() ?? null,
    subestado: corto(t.substatus),
    ultimoEvento: corto(t.latest_event) ?? eventos[0]?.detalle ?? null,
    ultimoEventoEn: corto(t.latest_checkpoint_time) ?? eventos[0]?.fecha ?? null,
    eventos: eventos.slice(0, MAX_EVENTOS),
  }
}

/** "2023-11-04T14:31:00-04:00" → "2023-11-04 14:31". La hora es la del courier, sin convertir. */
export function fechaCourier(s: string | null | undefined): string {
  if (!s) return ''
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : s
}

/** El mismo tracking en las dos puntas: número exacto y courier sin importar mayúsculas. */
export function mismoTracking(a: { numero: string; courierCode: string | null }, t: TrackingTM): boolean {
  return (
    (t.tracking_number ?? '') === a.numero &&
    (t.courier_code ?? '').toLowerCase() === (a.courierCode ?? '').toLowerCase()
  )
}

// ── Errores ──────────────────────────────────────────────────────────────────

// meta.code de TrackingMore que dicen "este tracking no sirve así": se guardan en la fila y no
// se reintentan solos. Los demás (clave, cupo, límite, servidor) cortan la corrida entera.
const ERRORES_DE_FILA: Record<number, string> = {
  4110: 'TrackingMore dice que el número no es válido.',
  4111: 'Falta el número de tracking.',
  4120: 'TrackingMore no reconoce ese courier.',
  4121: 'TrackingMore no pudo identificar el courier.',
  4122: 'Este courier pide datos extra (código postal, fecha de despacho o cuenta) para seguirlo.',
  4130: 'TrackingMore rechazó el formato de un campo.',
}
export const TM_YA_EXISTE = 4101
export const TM_NO_EXISTE = 4102

export function errorDeFila(code: number): string | null {
  return ERRORES_DE_FILA[code] ?? null
}

export function mensajeErrorGeneral(code: number, message: string): string {
  if (code === 401) return 'TrackingMore rechazó la clave (TRACKINGMORE_API_KEY).'
  if (code === 4190) return 'Se acabaron los créditos del plan de TrackingMore.'
  if (code === 429) return 'TrackingMore pidió ir más despacio (429). Se reintenta en la próxima corrida.'
  if (code >= 500) return `TrackingMore está con problemas (${code}). Se reintenta en la próxima corrida.`
  return `TrackingMore respondió ${code}: ${message}`
}

export class ErrorTrackingMore extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

type RespuestaTM<T> = { meta?: { code?: number; message?: string }; data?: T }

/**
 * Una llamada a la API. Devuelve `{ code, data }` con el meta.code de TrackingMore (también
 * en los 4xx: ahí vive el motivo). Solo tira si la red falla o la respuesta no es JSON.
 */
async function llamarApi<T>(
  apiKey: string,
  metodo: 'GET' | 'POST',
  ruta: string,
  body?: unknown,
): Promise<{ code: number; message: string; data: T | null }> {
  const res = await fetch(`${TM_BASE}${ruta}`, {
    method: metodo,
    headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  })
  let json: RespuestaTM<T>
  try {
    json = (await res.json()) as RespuestaTM<T>
  } catch {
    throw new ErrorTrackingMore(res.status, `TrackingMore respondió ${res.status} sin JSON.`)
  }
  return { code: json.meta?.code ?? res.status, message: json.meta?.message ?? res.statusText, data: json.data ?? null }
}

type CourierCrudo = { courier_code?: string | null; courier_name?: string | null; courier_country_iso2?: string | null }

/** GET /couriers/all → la lista para elegir. */
export async function apiCouriers(apiKey: string): Promise<CourierTM[]> {
  const r = await llamarApi<CourierCrudo[]>(apiKey, 'GET', '/couriers/all')
  if (r.code !== 200 || !Array.isArray(r.data)) throw new ErrorTrackingMore(r.code, mensajeErrorGeneral(r.code, r.message))
  const vistos = new Set<string>()
  const lista: CourierTM[] = []
  for (const c of r.data) {
    const code = (c.courier_code ?? '').trim().toLowerCase()
    const nombre = (c.courier_name ?? '').trim()
    if (!code || !nombre || vistos.has(code)) continue
    vistos.add(code)
    lista.push({ code, nombre, pais: (c.courier_country_iso2 ?? '').trim().toUpperCase() || null })
  }
  return lista
}

/**
 * POST /trackings/create. `creado` trae el tracking (la API responde ya con su estado),
 * `existe` es que ya estaba registrado (4101: no gasta otro crédito, se lee con apiConsultar),
 * `error` es un motivo de la fila. Lo demás tira ErrorTrackingMore y corta la corrida.
 */
export async function apiRegistrar(
  apiKey: string,
  t: { numero: string; courierCode: string; nota?: string },
): Promise<{ creado: TrackingTM } | { existe: true } | { error: string }> {
  const r = await llamarApi<TrackingTM>(apiKey, 'POST', '/trackings/create', {
    tracking_number: t.numero,
    courier_code: t.courierCode,
    ...(t.nota ? { note: t.nota } : {}),
  })
  if (r.code === 200 && r.data) return { creado: r.data }
  if (r.code === TM_YA_EXISTE) return { existe: true }
  const deFila = errorDeFila(r.code)
  if (deFila) return { error: deFila }
  throw new ErrorTrackingMore(r.code, mensajeErrorGeneral(r.code, r.message))
}

/** GET /trackings/get de hasta 40 números (de cualquier courier). */
export async function apiConsultar(apiKey: string, numeros: string[]): Promise<TrackingTM[]> {
  if (numeros.length === 0) return []
  if (numeros.length > TM_LOTE) throw new Error(`apiConsultar: máximo ${TM_LOTE} números`)
  const qs = new URLSearchParams({ tracking_numbers: numeros.join(','), items_amount: '200' })
  const r = await llamarApi<TrackingTM[]>(apiKey, 'GET', `/trackings/get?${qs}`)
  if (r.code === TM_NO_EXISTE) return []
  if (r.code !== 200) throw new ErrorTrackingMore(r.code, mensajeErrorGeneral(r.code, r.message))
  return Array.isArray(r.data) ? r.data : []
}
