import { db } from './db'
import { toConfigMap, type ConfigMap } from './config'

// El viaje a la base para traer Config, en un solo lugar.
//
// Vive separado de lib/config.ts porque aquel es puro y lo importa lib/calc.ts, que a su
// vez lo importan componentes 'use client'. Acá adentro está Prisma, así que este módulo
// es solo de server (páginas, server actions, scripts).
//
// Era `db.config.findMany()` + un `reduce` idéntico repetido en 17 archivos. Además de
// la repetición, cada copia era una oportunidad de olvidarse de que la tabla es chica y
// se lee entera: si algún día deja de serlo, el `select` se ajusta una vez, acá.

export async function getConfig(): Promise<ConfigMap> {
  return toConfigMap(await db.config.findMany())
}
