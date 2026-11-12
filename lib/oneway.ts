// One Way Cargo (onewaycargo.net): el courier que lleva las cajas de Miami a Caracas. No tiene
// API: la página de la cuenta la arma el servidor (Laravel) y se lee el HTML. Se sigue por SU
// código de almacén (MT-…, CON-…, SB-…, CA-…), anotado en el tramo `venezuela`: el tracking de
// USA no sirve para cruzar porque el número cambia entre el courier internacional y el local.
//
// Igual que Ship24, es una COPIA de lo que dice el courier: no mueve etapas, stock ni plata.
// Las filas se guardan con courierCode = ONEWAY_CODE (la UI las trata como seguidas) y la
// sincronización de Ship24 las deja afuera. La parte de la base está en lib/sync-trackings.ts.
//
// Si One Way Cargo cambia el HTML, la lectura devuelve vacío y la fila queda con error (no se
// pisa lo guardado): avisa en la caja en vez de fallar callado.

import type { Checkpoint } from './ship24'

export const ONEWAY_CODE = 'onewaycargo'
export const ONEWAY_NOMBRE = 'One Way Cargo'
export const ENV_ONEWAY = ['ONEWAY_EMAIL', 'ONEWAY_PASSWORD'] as const
const BASE = 'https://onewaycargo.net'

// MT marítimo, SB/CA aéreo, CON consolidado. Explícito a propósito: "MIA-12345" de otro courier
// no es de ellos. Un prefijo nuevo se agrega acá.
const RE_CODIGO = /^(MT|CON|SB|CA)-\d+$/i

export function esCodigoOneway(tramo: string, numero: string): boolean {
  return tramo === 'venezuela' && RE_CODIGO.test(numero.trim())
}

export function credencialesOneway(): { email: string; password: string } | null {
  const email = process.env.ONEWAY_EMAIL?.trim()
  const password = process.env.ONEWAY_PASSWORD
  return email && password ? { email, password } : null
}

// ── Lectura del HTML (pura) ──────────────────────────────────────────────────

const texto = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()

/** Código → uuid del pedido, de la lista (pestaña en tránsito o historial). */
export function leerLista(html: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of html.matchAll(/href="[^"]*\/onewayidv2\/orders\/([0-9a-f-]{36})"[^>]*>(?:\s|<[^>]+>)*([A-Z]+-\d+)/gi)) {
    m.set(r[2].toUpperCase(), r[1])
  }
  return m
}

const MESES: Record<string, string> = {
  ene: '01', jan: '01', feb: '02', mar: '03', abr: '04', apr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', aug: '08', sep: '09', oct: '10', nov: '11', dic: '12', dec: '12',
}

/** "Oct 09, 2026 - 02:38 PM" → "2026-10-09T14:38" (hora de Miami, sin zona). Si no se entiende, tal cual. */
export function fechaOneway(s: string): string {
  const m = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}) - (\d{1,2}):(\d{2}) ?([AP])\.? ?M\.?$/i)
  const mes = m && MESES[m[1].toLowerCase()]
  if (!m || !mes) return s
  const h = (Number(m[4]) % 12) + (m[6].toUpperCase() === 'P' ? 12 : 0)
  return `${m[3]}-${mes}-${m[2].padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5]}`
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** El estado (en los términos de Ship24, para reusar la UI) según el último paso. */
export function estadoOneway(ultimo: string | null): string {
  const t = sinTildes(ultimo ?? '')
  if (!t) return 'pending'
  if (t.includes('despachado') || t.includes('entregad')) return 'delivered'
  if (t.includes('hold')) return 'exception'
  return 'in_transit'
}

// Hasta el cierre de la etiqueta sin cruzar otra igual: una regex perezosa simple se come el
// encabezado "Historial del pedido" pegado al primer paso.
const dentro = (tag: string) => `<${tag}[^>]*>((?:(?!<\\/?${tag}[\\s>])[\\s\\S])*)<\\/${tag}>`
const RE_PASO = new RegExp(`${dentro('h3')}\\s*${dentro('p')}\\s*${dentro('p')}`, 'g')

export type DetalleOneway = {
  /** Del más nuevo al más viejo, como los de Ship24. `lugar` lleva la descripción del paso. */
  eventos: Checkpoint[]
  estado: string
  /** El paso actual, tal cual. */
  subestado: string | null
}

export function leerDetalle(html: string): DetalleOneway {
  const i = html.indexOf('id="historial_pedido"')
  const pasos: Checkpoint[] = []
  if (i !== -1) {
    for (const m of html.slice(i).matchAll(RE_PASO)) {
      const detalle = texto(m[1])
      if (!detalle) continue
      // La descripción ("Tiempo estimado: de 14 a 18 días hábiles") va en `lugar`, que la caja
      // muestra debajo de la fecha: One Way Cargo no da lugar.
      pasos.push({ fecha: fechaOneway(texto(m[3])), detalle, lugar: texto(m[2]) || null, estado: null })
    }
  }
  const eventos = pasos.reverse()
  return { eventos, estado: estadoOneway(eventos[0]?.detalle ?? null), subestado: eventos[0]?.detalle ?? null }
}

// ── Conexión ─────────────────────────────────────────────────────────────────

/** Lo que corta la corrida entera (login, sesión, red): no es culpa de una fila. */
export class ErrorOneway extends Error {}

const TIMEOUT_MS = 20_000
// El formulario de login tiene un honeypot que rechaza los envíos demasiado rápidos.
const ESPERA_LOGIN_MS = 4_000

export type SesionOneway = { pagina: (path: string) => Promise<string> }

export async function entrarOneway(cred: { email: string; password: string }): Promise<SesionOneway> {
  const jar = new Map<string, string>()
  const pedir = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(BASE + path, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'user-agent': 'Mozilla/5.0 (motokira)', ...init.headers },
    })
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]
      const j = kv.indexOf('=')
      if (j > 0) jar.set(kv.slice(0, j), kv.slice(j + 1))
    }
    return r
  }

  const form = await pedir('/login')
  if (form.status !== 200) throw new ErrorOneway(`One Way Cargo no abrió el login (HTTP ${form.status}).`)
  const html = await form.text()
  const valor = (n: string) =>
    html.match(new RegExp(`name="${n}"[^>]*value="([^"]*)"`))?.[1] ?? html.match(new RegExp(`value="([^"]*)"[^>]*name="${n}"`))?.[1]
  const token = valor('_token')
  if (!token) throw new ErrorOneway('El login de One Way Cargo cambió: no se encontró el formulario.')
  const body = new URLSearchParams({ _token: token, valid_from: valor('valid_from') ?? '', email: cred.email, ci_password: cred.password })
  const trampa = html.match(/name="(direccion_completa_[^"]+)"/)?.[1]
  if (trampa) body.set(trampa, '')

  await new Promise(r => setTimeout(r, ESPERA_LOGIN_MS))
  const login = await pedir('/login', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  const destino = login.headers.get('location') ?? ''
  if (login.status !== 302 || /\/login\b/.test(destino)) {
    throw new ErrorOneway('One Way Cargo rechazó el login: revisá ONEWAY_EMAIL y ONEWAY_PASSWORD.')
  }

  return {
    async pagina(path: string) {
      const r = await pedir(path)
      if (r.status !== 200) throw new ErrorOneway(`One Way Cargo respondió HTTP ${r.status} en ${path.split('?')[0]} (¿se cerró la sesión?).`)
      return r.text()
    },
  }
}

// Tope de páginas por pestaña: solo frena un bucle si la paginación cambiara.
const MAX_PAGINAS = 30

/** Código → uuid de todos los pedidos de la cuenta (en tránsito e historial, todas las páginas). */
export async function pedidosOneway(s: SesionOneway): Promise<Map<string, string>> {
  const todos = new Map<string, string>()
  for (const tab of ['transit', 'history']) {
    // Paginación de Laravel (?page=N): pasada la última viene la lista vacía. Se corta también si
    // una página no trae nada nuevo, por si alguna vez repite la última en vez de vaciarse.
    for (let page = 1; page <= MAX_PAGINAS; page++) {
      const antes = todos.size
      for (const [k, v] of leerLista(await s.pagina(`/onewayidv2/orders?tab=${tab}&page=${page}`))) todos.set(k, v)
      if (todos.size === antes) break
    }
  }
  return todos
}

export async function detalleOneway(s: SesionOneway, uuid: string): Promise<DetalleOneway> {
  return leerDetalle(await s.pagina(`/onewayidv2/orders/${uuid}`))
}
