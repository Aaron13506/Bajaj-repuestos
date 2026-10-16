import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

// Prisma va por el driver adapter de node-postgres (y no por su query engine con
// `pgbouncer=true`) desde los tiempos de Supabase: node-postgres no usa prepared statements con
// nombre, así que una consulta es un viaje y no hay errores 26000 bajo concurrencia.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pool: Pool | undefined
}

// La base vive en la misma máquina (producción en Lightsail, Docker en la PC, el túnel SSH en
// localhost:15432): ahí no hay TLS. Si algún día DATABASE_URL apunta afuera, se exige TLS
// validado contra las CA del sistema — nunca sin validar.
const dbUrl = process.env.DATABASE_URL ?? ''
const esLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)/.test(dbUrl)

const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: dbUrl,
    ssl: esLocal ? undefined : { rejectUnauthorized: true },
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
