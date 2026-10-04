/**
 * Aplica los cambios de esquema de prisma/manual/*.sql a una base, en orden y UNA sola vez cada uno.
 *
 *   pnpm db:migrar                        estado: qué está aplicado, qué falta, qué cambió (solo lee)
 *   pnpm db:migrar --probar               corre las pendientes dentro de una transacción y hace ROLLBACK:
 *                                         ensaya el SQL contra los datos reales sin dejar nada
 *   pnpm db:migrar --aplicar              aplica las pendientes y compara la base contra schema.prisma
 *   pnpm db:migrar --baseline=<archivo>   (una sola vez por base) declara que todo hasta ese archivo,
 *                                         inclusive, YA está aplicado; no ejecuta nada. Va con --aplicar
 *                                         o --probar, o solo para registrar el punto de partida
 *   pnpm db:migrar --drift                solo compara la base contra schema.prisma
 *   pnpm db:migrar --pendientes           imprime cuántas faltan (lo usa deploy.sh)
 *   --dir=<ruta>                          otra carpeta de .sql (por defecto prisma/manual)
 *   --sin-drift                           no compara contra schema.prisma al final
 *
 * Por qué existe: los .sql se aplicaban a mano y nada sabía cuáles ya habían corrido. Aplicar dos
 * veces uno que no es idempotente rompe la base, y olvidar uno rompe la app nueva (su cliente de
 * Prisma sale de schema.prisma). Acá cada archivo corre en su propia transacción JUNTO con su
 * registro en "MigracionManual": o quedan los dos o no queda ninguno.
 *
 * Convenciones de los .sql:
 *   · Se llaman AAAA-MM-DD-nombre.sql: el orden es el del nombre.
 *   · Se escriben SIN BEGIN/COMMIT: el ejecutor los envuelve. (Si los traen, se quitan las líneas
 *     BEGIN; y COMMIT; sueltas, así los archivos viejos siguen valiendo.)
 *   · Lo que no puede ir en una transacción (CREATE INDEX CONCURRENTLY, ALTER TYPE … ADD VALUE) lleva
 *     como comentario `-- sin-transaccion`: corre suelto y se registra después. No se puede probar.
 *   · Una vez aplicado, un archivo NO se edita (se detecta por checksum): el cambio va en otro.
 *
 * Usa DIRECT_URL o DATABASE_URL: contra producción corre en el servidor (ver deploy/deploy.sh --migrar).
 */
import { Client } from 'pg'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

try { process.loadEnvFile() } catch {}

const RAIZ = path.resolve(__dirname, '..')
const LOCK_ID = 727_274 // pg_advisory_lock: una sola corrida a la vez por base

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const valor = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const CONOCIDOS = ['aplicar', 'probar', 'drift', 'pendientes', 'sin-drift']
for (const a of args) {
  const nombre = a.replace(/^--/, '').split('=')[0]
  if (!a.startsWith('--') || ![...CONOCIDOS, 'baseline', 'dir'].includes(nombre)) {
    console.error(`Opción desconocida: ${a}`)
    process.exit(2)
  }
}

const dir = path.resolve(RAIZ, valor('dir') ?? 'prisma/manual')
const baseline = valor('baseline')
const aplicar = flag('aplicar')
const probar = flag('probar')

interface Migracion {
  nombre: string
  sql: string
  checksum: string
  transaccional: boolean
}

const die = (msg: string, code = 1): never => { console.error(`✗ ${msg}`); process.exit(code) }

function leerMigraciones(): Migracion[] {
  const nombres = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  return nombres.map(nombre => {
    if (!/^\d{4}-\d{2}-\d{2}-.+\.sql$/.test(nombre)) {
      die(`«${nombre}» no sigue AAAA-MM-DD-nombre.sql: el orden de aplicación sale del nombre.`)
    }
    const sql = readFileSync(path.join(dir, nombre), 'utf8')
    // CRLF y LF dan el mismo checksum: un checkout de Windows no puede contar como una edición.
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
    const cabecera = sql.split(/\r?\n/).slice(0, 20).join('\n')
    return { nombre, sql, checksum, transaccional: !/^\s*--\s*sin-transaccion\b/im.test(cabecera) }
  })
}

// Los archivos anteriores a este ejecutor traían su propio BEGIN/COMMIT: dentro de la transacción
// del ejecutor un COMMIT suelto cerraría el registro antes de tiempo.
const sinTransaccion = (sql: string) => sql.replace(/^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*\r?$/gim, '')

function urlDeConexion(): string {
  const raw = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!raw) die('Falta DIRECT_URL o DATABASE_URL.')
  const u = new URL(raw!)
  u.searchParams.delete('schema') // lo entiende Prisma, no el driver
  return u.toString()
}

const descripcion = (url: string) => { const u = new URL(url); return `${u.hostname}:${u.port || 5432}${u.pathname}` }

async function leerRegistro(c: Client): Promise<Map<string, string> | null> {
  const t = await c.query(`SELECT to_regclass('"MigracionManual"') IS NOT NULL AS existe`)
  if (!t.rows[0].existe) return null
  const r = await c.query<{ nombre: string; checksum: string }>(`SELECT "nombre", "checksum" FROM "MigracionManual"`)
  return new Map(r.rows.map(x => [x.nombre, x.checksum]))
}

const CREAR_REGISTRO = `
  CREATE TABLE IF NOT EXISTS "MigracionManual" (
    "nombre"     TEXT NOT NULL,
    "checksum"   TEXT NOT NULL,
    "aplicadaAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MigracionManual_pkey" PRIMARY KEY ("nombre")
  )`
const REGISTRAR = `INSERT INTO "MigracionManual" ("nombre", "checksum") VALUES ($1, $2)`

interface Estado {
  /** Lo que ya corrió (del registro) o se da por corrido (baseline). */
  aplicadas: Map<string, string>
  modificadas: string[]
  huerfanas: string[]
  pendientes: Migracion[]
  /** Falta registrar el punto de partida: hay que escribir el baseline. */
  baselineAEscribir: Migracion[]
}

/**
 * El archivo al que apunta --baseline. Un baseline equivocado registra como "ya aplicado" algo que
 * no corrió, así que el criterio es estricto pero perdona lo que es solo un descuido al tipear:
 * el nombre sin extensión o cortado vale si es un prefijo (de al menos la fecha) que identifica UN
 * solo archivo. Se dice a cuál se resolvió, por stderr (stdout lo lee deploy.sh).
 */
function resolverBaseline(files: Migracion[], pedido: string): string {
  const exacto = files.find(f => f.nombre === pedido)
  if (exacto) return exacto.nombre
  const candidatos = pedido.length >= 10 ? files.filter(f => f.nombre.startsWith(pedido)) : []
  if (candidatos.length === 1) {
    console.error(`ℹ --baseline=${pedido} → ${candidatos[0].nombre}`)
    return candidatos[0].nombre
  }
  return die(
    `--baseline=${pedido}: ${candidatos.length > 1 ? 'es ambiguo' : 'no existe'} en ${path.relative(RAIZ, dir)}.\n` +
    `  Los últimos archivos: ${files.slice(-4).map(f => f.nombre).join(', ')}`,
  )
}

function calcularEstado(files: Migracion[], registro: Map<string, string> | null): Estado {
  let aplicadas: Map<string, string>
  let baselineAEscribir: Migracion[] = []

  if (registro && registro.size > 0) {
    if (baseline) die('Esta base ya tiene registro de migraciones: --baseline solo vale la primera vez.')
    aplicadas = registro
  } else if (files.length === 0) {
    aplicadas = new Map()
  } else if (!baseline) {
    return die(
      'Esta base no tiene registro de migraciones.\n' +
      '  Si ya tiene aplicados los .sql de prisma/manual hasta cierto punto, declará cuál fue el último:\n' +
      `    pnpm db:migrar --baseline=<archivo>      (el último es ${files[files.length - 1].nombre})\n` +
      '  Se registran como ya aplicados ese y los anteriores, sin ejecutarlos.',
    )
  } else {
    const nombreBase = resolverBaseline(files, baseline)
    const i = files.findIndex(f => f.nombre === nombreBase)
    baselineAEscribir = files.slice(0, i + 1)
    aplicadas = new Map(baselineAEscribir.map(f => [f.nombre, f.checksum]))
  }

  const porNombre = new Map(files.map(f => [f.nombre, f]))
  const modificadas = [...aplicadas].filter(([n, ck]) => porNombre.has(n) && porNombre.get(n)!.checksum !== ck).map(([n]) => n)
  const huerfanas = [...aplicadas.keys()].filter(n => !porNombre.has(n))
  const pendientes = files.filter(f => !aplicadas.has(f.nombre))
  return { aplicadas, modificadas, huerfanas, pendientes, baselineAEscribir }
}

function imprimirEstado(files: Migracion[], e: Estado) {
  for (const f of files) {
    const marca = e.modificadas.includes(f.nombre) ? '✗ MODIFICADA' : e.aplicadas.has(f.nombre) ? '✓' : '○ PENDIENTE'
    const esBase = e.baselineAEscribir.some(b => b.nombre === f.nombre) ? '  (baseline)' : ''
    console.log(`  ${marca.padEnd(13)} ${f.nombre}${f.transaccional ? '' : '  [sin transacción]'}${esBase}`)
  }
  for (const n of e.huerfanas) console.log(`  ? registrada pero ya no existe el archivo: ${n}`)
}

/** Compara la base contra prisma/schema.prisma: 'ok' | 'diferente' | 'error'. */
function drift(url: string): 'ok' | 'diferente' | 'error' {
  // Un solo string con shell: todos los argumentos son fijos (la URL viaja por entorno), y así no
  // hay que pasar un array con shell:true, que Node desaconseja.
  const r = spawnSync(
    'pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code --script',
    { cwd: RAIZ, encoding: 'utf8', shell: true, env: { ...process.env, DATABASE_URL: url } },
  )
  if (r.status === 0) return 'ok'
  if (r.status === 2) {
    console.error('✗ La base NO coincide con prisma/schema.prisma. Para igualarla haría falta:')
    console.error(r.stdout.trim().split('\n').map(l => `    ${l}`).join('\n'))
    return 'diferente'
  }
  console.error(`✗ No se pudo comparar contra schema.prisma:\n${(r.stderr || r.stdout).trim()}`)
  return 'error'
}

async function main() {
  const files = leerMigraciones()
  const url = urlDeConexion()

  if (flag('drift')) {
    const d = drift(url)
    if (d === 'ok') console.log(`✓ ${descripcion(url)} coincide con prisma/schema.prisma.`)
    process.exit(d === 'ok' ? 0 : d === 'diferente' ? 3 : 1)
  }

  const c = new Client({ connectionString: url })
  await c.connect()
  c.on('notice', n => console.log(`      NOTICE: ${n.message}`))

  try {
    const registro = await leerRegistro(c)
    const e = calcularEstado(files, registro)

    if (flag('pendientes')) {
      if (e.modificadas.length) die(`Migraciones ya aplicadas fueron editadas: ${e.modificadas.join(', ')}.`)
      console.log(e.pendientes.length)
      return
    }

    console.log(`Migraciones manuales — ${descripcion(url)} — ${path.relative(RAIZ, dir) || '.'}\n`)
    imprimirEstado(files, e)
    console.log()

    if (e.modificadas.length) {
      die(
        `${e.modificadas.length} migración(es) ya aplicada(s) cambió su contenido: ${e.modificadas.join(', ')}.\n` +
        '  Un archivo aplicado no se edita; el cambio va en uno nuevo. (Si fue solo un retoque que no altera\n' +
        '  lo que hizo, restaurá el original con git.) No se aplica nada.',
      )
    }
    const aplicadasMax = [...e.aplicadas.keys()].sort().pop() ?? ''
    const antiguas = e.pendientes.filter(p => p.nombre < aplicadasMax)
    if (antiguas.length) {
      console.log(`⚠ Pendiente(s) con fecha anterior a otra ya aplicada (${aplicadasMax}): ${antiguas.map(a => a.nombre).join(', ')}\n  Se aplican igual, en orden de nombre; revisá que no dependan de lo que vino después.\n`)
    }

    if (!aplicar && !probar) {
      if (e.baselineAEscribir.length) console.log(`(con --baseline: se registrarían ${e.baselineAEscribir.length} como ya aplicadas)`)
      console.log(e.pendientes.length === 0
        ? '✓ Nada pendiente.'
        : `${e.pendientes.length} pendiente(s). --probar las ensaya sin dejar nada; --aplicar las aplica.`)
      if (!flag('sin-drift') && e.pendientes.length === 0 && registro) {
        if (drift(url) === 'ok') console.log('✓ La base coincide con prisma/schema.prisma.')
      }
      return
    }

    // ── candado: una sola corrida a la vez ──
    const lock = await c.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_ID])
    if (!lock.rows[0].ok) die('Otra corrida de migrar está en curso en esta base.')

    if (probar) {
      console.log('PROBAR: todo dentro de una transacción que se deshace al final.\n')
      let omitidas = 0
      await c.query('BEGIN')
      try {
        if (!registro) await c.query(CREAR_REGISTRO)
        for (const f of e.baselineAEscribir) await c.query(REGISTRAR, [f.nombre, f.checksum])
        for (const m of e.pendientes) {
          if (!m.transaccional) { omitidas++; console.log(`  – ${m.nombre}: sin transacción, NO se puede probar (se omite; lo que dependa de él puede fallar)`); continue }
          const t0 = Date.now()
          await c.query(sinTransaccion(m.sql))
          await c.query(REGISTRAR, [m.nombre, m.checksum])
          console.log(`  ✓ ${m.nombre} (${Date.now() - t0} ms)`)
        }
      } catch (err) {
        await c.query('ROLLBACK')
        die(`Falló al probar: ${(err as Error).message}\n  No se dejó nada.`)
      }
      await c.query('ROLLBACK')
      const probadas = e.pendientes.length - omitidas
      console.log(`\n✓ Probado y deshecho: ${probadas} migración(es) corren limpias contra esta base${omitidas ? ` (${omitidas} omitida(s) por no ser transaccionales)` : ''}. No se escribió nada.`)
      return
    }

    // ── aplicar ──
    if (e.baselineAEscribir.length) {
      await c.query('BEGIN')
      if (!registro) await c.query(CREAR_REGISTRO)
      for (const f of e.baselineAEscribir) await c.query(REGISTRAR, [f.nombre, f.checksum])
      await c.query('COMMIT')
      console.log(`✓ Baseline: ${e.baselineAEscribir.length} migración(es) registradas como ya aplicadas (no se ejecutaron).`)
    }

    let hechas = 0
    for (const m of e.pendientes) {
      console.log(`→ ${m.nombre}`)
      const t0 = Date.now()
      try {
        if (m.transaccional) {
          await c.query('BEGIN')
          await c.query(sinTransaccion(m.sql))
          await c.query(REGISTRAR, [m.nombre, m.checksum])
          await c.query('COMMIT')
        } else {
          await c.query(m.sql)
          await c.query(REGISTRAR, [m.nombre, m.checksum])
        }
      } catch (err) {
        if (m.transaccional) await c.query('ROLLBACK').catch(() => {})
        console.error(`✗ ${m.nombre} falló: ${(err as Error).message}`)
        console.error(m.transaccional
          ? '  Su transacción se deshizo: la base quedó como antes de este archivo.'
          : '  Corría SIN transacción: puede haber quedado a medias. Revisá la base antes de seguir.')
        console.error(`  Aplicadas en esta corrida antes del fallo: ${hechas}. Las que siguen NO se corrieron.`)
        process.exit(1)
      }
      hechas++
      console.log(`  ✓ aplicada (${Date.now() - t0} ms)`)
    }
    if (hechas === 0 && e.baselineAEscribir.length === 0) console.log('✓ Nada pendiente.')

    if (!flag('sin-drift')) {
      const d = drift(url)
      if (d === 'ok') console.log('✓ La base coincide con prisma/schema.prisma.')
      else process.exit(d === 'diferente' ? 3 : 1)
    }
  } finally {
    await c.end()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
