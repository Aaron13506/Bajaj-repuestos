import { NextRequest, NextResponse } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// La puerta de entrada. Basic Auth sobre todo el sitio, con dos reglas que antes
// no estaban y que son las que hacen que la puerta valga algo.
//
// 1. LOS DEFAULTS SOLO EXISTEN EN LOCAL.
//    `admin` / `admin123` estaban como fallback de un `??`, así que un dyno sin
//    config vars —o con el nombre de la variable mal tipeado, que es lo que pasa
//    de verdad— quedaba abierto con las credenciales que están escritas en el
//    README. El fallback ahora vive detrás de `APP_ENV=local`: si el entorno no se
//    declaró local no hay default, y el sitio FALLA CERRADO (503) en vez de
//    abrirse. Un 503 se nota en el primer minuto; una puerta abierta no se nota
//    nunca.
//
//    Fuera de local tampoco se acepta `admin123` aunque esté cargada a mano en
//    ADMIN_PASSWORD: es una clave publicada, no un secreto, y que alguien la haya
//    escrito adrede no la convierte en uno. Se chequea la CLAVE y no el par, porque
//    el usuario nunca fue la parte secreta.
//
// 2. CINCO INTENTOS Y SE CIERRA.
//    Un Basic Auth expuesto a internet sin freno es fuerza bruta a discreción, y acá
//    hay UN solo par de credenciales que abre precios, costos y clientes. Cinco
//    fallos por IP y la IP queda bloqueada 15 minutos; cada bloqueo nuevo duplica el
//    castigo hasta 24 h. Un atacante pasa de intentos ilimitados por día a unos 40.
//
// El estado del limitador es EN MEMORIA y por instancia: con un dyno —el caso de
// hoy— es exacto; si algún día hay dos, cada uno cuenta los suyos y el techo real se
// multiplica por la cantidad de instancias. Cuando eso pase, el contador se muda a la
// base o a Redis. No se guarda en Config a propósito: leerlo costaría un viaje a
// us-west-2 en CADA request, incluido el de un atacante, que es justo quien no
// debería poder hacernos gastar.
// ─────────────────────────────────────────────────────────────────────────────

// El único interruptor que habilita las credenciales de juguete. Se declara en el
// .env local y en ningún otro lado: Heroku no lo tiene y no debe tenerlo.
const ES_LOCAL = process.env.APP_ENV === 'local'

const USER_POR_DEFECTO = 'admin'
const PASS_POR_DEFECTO = 'admin123'

const ADMIN_USER = process.env.ADMIN_USER ?? (ES_LOCAL ? USER_POR_DEFECTO : '')
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? (ES_LOCAL ? PASS_POR_DEFECTO : '')

// Sin credenciales, o con la clave del README fuera de local. En los dos casos no se
// atiende a nadie: es un error de despliegue, no un intento de entrar.
const MAL_CONFIGURADO =
  !ADMIN_USER || !ADMIN_PASS || (!ES_LOCAL && ADMIN_PASS === PASS_POR_DEFECTO)

// ── Limitador ────────────────────────────────────────────────────────────────
const MAX_INTENTOS    = 5
const VENTANA_MS      = 15 * 60 * 1000       // los 5 fallos tienen que caer acá dentro
const BLOQUEO_BASE_MS = 15 * 60 * 1000
const BLOQUEO_MAX_MS  = 24 * 60 * 60 * 1000
const MAX_IPS         = 5_000                // techo del Map, para que no crezca solo

interface Intentos {
  fallos: number
  /** Inicio de la ventana: los fallos viejos no se acumulan con los nuevos. */
  desde: number
  /** Hasta cuándo la IP está cerrada. 0 = abierta. */
  bloqueoHasta: number
  /** Cuántas veces ya se bloqueó. Cada una duplica el próximo castigo. */
  bloqueos: number
}

// Igual que el cliente de Prisma: colgado de globalThis para sobrevivir al
// hot-reload de dev, que si no reinicia el contador en cada guardado.
const globalForAuth = globalThis as unknown as { intentosAuth?: Map<string, Intentos> }
const intentos = (globalForAuth.intentosAuth ??= new Map<string, Intentos>())

// Heroku APPENDEA la IP real al final de X-Forwarded-For, así que el ÚLTIMO valor es
// el que puso el router y el único que el cliente no puede falsificar. Tomar el
// primero —lo habitual— sería dejar que cualquiera se saltee el bloqueo mandando un
// header inventado.
function clienteIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const partes = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (partes.length > 0) return partes[partes.length - 1]
  }
  return request.headers.get('x-real-ip')?.trim() || 'desconocida'
}

// Saca las entradas ya vencidas cuando el Map se pasa de tamaño. Sin esto, un escaneo
// con IPs rotativas lo hace crecer sin techo.
function podar(ahora: number): void {
  if (intentos.size <= MAX_IPS) return
  for (const [ip, e] of intentos) {
    if (e.bloqueoHasta < ahora && ahora - e.desde > VENTANA_MS) intentos.delete(ip)
  }
}

/** Milisegundos que faltan para que la IP pueda volver a intentar. 0 = puede. */
function bloqueoRestante(ip: string, ahora: number): number {
  const e = intentos.get(ip)
  if (!e || e.bloqueoHasta <= ahora) return 0
  return e.bloqueoHasta - ahora
}

/** Anota un fallo y devuelve cuántos intentos quedan antes del bloqueo. */
function registrarFallo(ip: string, ahora: number): number {
  const previo = intentos.get(ip)
  // Ventana vencida: los fallos de hace media hora no se suman a los de ahora. Los
  // BLOQUEOS sí se conservan, y por eso la escalada funciona — si se reiniciaran,
  // alcanzaría con esperar la ventana para volver a tener el castigo más blando.
  const e: Intentos =
    previo && ahora - previo.desde <= VENTANA_MS
      ? previo
      : { fallos: 0, desde: ahora, bloqueoHasta: 0, bloqueos: previo?.bloqueos ?? 0 }

  e.fallos++

  if (e.fallos >= MAX_INTENTOS) {
    e.bloqueos++
    const castigo = Math.min(BLOQUEO_BASE_MS * 2 ** (e.bloqueos - 1), BLOQUEO_MAX_MS)
    e.bloqueoHasta = ahora + castigo
    e.fallos = 0
    e.desde = ahora
  }

  intentos.set(ip, e)
  podar(ahora)
  return e.bloqueoHasta > ahora ? 0 : MAX_INTENTOS - e.fallos
}

function registrarExito(ip: string): void {
  intentos.delete(ip)
}

// ── Comparación en tiempo constante ──────────────────────────────────────────
// `a !== b` corta en el primer carácter distinto, así que cuánto tarda en responder
// cuenta cuántos caracteres acertaste. Comparar los digests SHA-256 en vez de los
// textos resuelve de paso el largo: son 32 bytes siempre, así que el tiempo tampoco
// delata cuántos caracteres tiene la clave.
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

function iguales(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0)
  return diff === 0
}

async function credencialesValidas(user: string, pass: string): Promise<boolean> {
  const [u, uOk, p, pOk] = await Promise.all([
    digest(user), digest(ADMIN_USER), digest(pass), digest(ADMIN_PASS),
  ])
  // Las dos comparaciones se evalúan siempre, sin corto circuito: con un `&&` que
  // corta, el tiempo de respuesta diría si el usuario existe antes de mirar la clave.
  const okUser = iguales(u, uOk)
  const okPass = iguales(p, pOk)
  return okUser && okPass
}

function decodificar(b64: string): { user: string; pass: string } | null {
  try {
    // atob devuelve los bytes como caracteres; hay que re-decodificarlos como UTF-8 o
    // una clave con acentos o ñ no coincide nunca ni consigo misma.
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const texto = new TextDecoder().decode(bytes)
    const i = texto.indexOf(':')
    if (i < 0) return null
    return { user: texto.slice(0, i), pass: texto.slice(i + 1) }
  } catch {
    return null
  }
}

// ── Respuestas ───────────────────────────────────────────────────────────────
function pedirCredenciales(mensaje: string): NextResponse {
  return new NextResponse(mensaje, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Bajaj Repuestos Admin"',
      'Cache-Control': 'no-store',
    },
  })
}

function bloqueado(restanteMs: number): NextResponse {
  const minutos = Math.max(1, Math.ceil(restanteMs / 60_000))
  // Sin WWW-Authenticate a propósito: con él, el navegador vuelve a pedir la clave y
  // el usuario queda en un bucle de prompts contra una puerta que no va a abrir.
  return new NextResponse(
    `Demasiados intentos fallidos. Esta IP quedó bloqueada por ${minutos} minuto(s).`,
    {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil(restanteMs / 1000)),
        'Cache-Control': 'no-store',
      },
    },
  )
}

function malConfigurado(): NextResponse {
  return new NextResponse(
    'El servidor no tiene credenciales de administracion validas. ' +
      'Defini ADMIN_USER y ADMIN_PASSWORD (y no uses la clave de ejemplo). ' +
      'Los valores por defecto solo funcionan con APP_ENV=local.',
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function middleware(request: NextRequest) {
  if (MAL_CONFIGURADO) return malConfigurado()

  const ahora = Date.now()
  const ip = clienteIp(request)

  const restante = bloqueoRestante(ip, ahora)
  if (restante > 0) return bloqueado(restante)

  const header = request.headers.get('authorization')
  // Un request SIN credenciales no es un intento fallido: es el primero de cualquier
  // navegador, que todavía no sabe que hay que autenticarse. Contarlo bloquearía al
  // dueño de la app al quinto click sin que nadie haya tipeado nada.
  if (!header?.startsWith('Basic ')) return pedirCredenciales('Autenticacion requerida')

  const cred = decodificar(header.slice('Basic '.length))
  const ok = cred != null && (await credencialesValidas(cred.user, cred.pass))

  if (!ok) {
    const quedan = registrarFallo(ip, ahora)
    if (quedan === 0) return bloqueado(bloqueoRestante(ip, ahora))
    return pedirCredenciales(`Credenciales invalidas. Quedan ${quedan} intento(s) antes del bloqueo.`)
  }

  registrarExito(ip)
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
