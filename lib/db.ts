import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

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
// `rejectUnauthorized: false` deja el tráfico cifrado sin validar el certificado, que es
// exactamente lo que hacía Prisma antes (su default es sslmode=prefer): el pooler
// presenta un certificado firmado por la CA propia de Supabase y la validación completa
// falla salvo que se empaquete esa CA. La base local de docker-compose no habla TLS, así
// que se exceptúa por host.
const dbUrl = process.env.DATABASE_URL ?? ''
const esLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)/.test(dbUrl)

// Abrir una conexión al pooler cuesta ~2,5 s (TCP + TLS + auth). Con el default de
// node-postgres (cerrar a los 10 s de ocio) una app de uso esporádico como esta paga
// ese arranque casi en cada visita, así que las conexiones se dejan vivas.
const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: dbUrl,
    ssl: esLocal ? undefined : { rejectUnauthorized: false },
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
