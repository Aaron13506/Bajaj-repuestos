import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { rootCertificates } from 'node:tls'
import { SUPABASE_ROOT_CA } from './supabase-ca'

// La base es Supabase remota y el pooler está en us-west-2: cada ida y vuelta cuesta
// caro, así que lo que manda en el tiempo de una página no es lo que tarda Postgres
// sino CUÁNTAS veces se cruza la red.
//
// Con el query engine nativo apuntando al pooler en modo transacción hay que pasarle
// `pgbouncer=true`, y eso le sale carísimo: como no puede confiar en que dos consultas
// caigan en el mismo backend, envuelve CADA consulta en su propia transacción y limpia
// los prepared statements antes de correrla. Una sola llamada a `db.config.findMany()`
// eran cuatro viajes — BEGIN, DEALLOCATE ALL, el SELECT y COMMIT — ~830 ms en vez de
// ~200. No es opcional sacar el flag a secas: sin él saltan errores 26000
// ("prepared statement s0 does not exist") en cuanto hay dos consultas concurrentes.
//
// El driver adapter esquiva el problema de raíz: node-postgres no usa prepared
// statements con nombre, así que no hay nada que desalojar ni transacción que abrir.
// Un viaje por consulta, y sin 26000 bajo concurrencia.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pool: Pool | undefined
}

// El motor de Prisma negociaba TLS por su cuenta; node-postgres NO lo hace salvo que se
// le pida, así que sin esto la conexión a Supabase viajaría en claro por internet.
//
// Acá estuvo `rejectUnauthorized: false`, con el argumento de que dejaba el tráfico
// cifrado y que empaquetar la CA de Supabase era el precio de validarlo. Cifrado sin
// validar es la mitad que no sirve: TLS sin autenticar al otro lado acepta el certificado
// de cualquiera, así que un intermediario en el camino monta el túnel con vos, lo abre, y
// lee y modifica todo lo que pasa —credenciales de la base incluidas— sin que se note. Y
// la CA es un archivo de 1 KB.
//
// Ahora se valida de verdad, contra las CA del sistema MÁS la raíz de Supabase (ver
// lib/supabase-ca.ts). Van las dos juntas porque el `ca` de Node REEMPLAZA el almacén por
// defecto: con solo la de Supabase, apuntar DATABASE_URL a cualquier otro proveedor
// —uno con certificado de una CA pública— dejaría de conectar.
//
// La base local de docker-compose no habla TLS, así que se exceptúa por host.
const dbUrl = process.env.DATABASE_URL ?? ''
const esLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)/.test(dbUrl)

// Escape hatch para el día que Supabase rote la raíz (vence en 2031) o para un Postgres
// con una CA interna: se carga el PEM en la env var y no hay que tocar código.
const caExtra = process.env.DATABASE_CA_CERT?.trim()
const ca = [...rootCertificates, caExtra || SUPABASE_ROOT_CA]

// Abrir una conexión al pooler cuesta ~2,5 s (TCP + TLS + auth). Con el default de
// node-postgres (cerrar a los 10 s de ocio) una app de uso esporádico como esta paga
// ese arranque casi en cada visita, así que las conexiones se dejan vivas.
const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: dbUrl,
    ssl: esLocal ? undefined : { ca, rejectUnauthorized: true },
    max: 10,
    idleTimeoutMillis: 0,
    keepAlive: true,
  })

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

// Persist in all environments — prevents multiple clients on hot-reload (dev)
// and across module re-imports in production
globalForPrisma.prisma = db
globalForPrisma.pool = pool
