import { PrismaClient } from '@prisma/client'

// Carga (sin pisar) los parámetros del modo Marítimo CBM en Config.
//
// Existe aparte de prisma/seed.ts porque ese seed también reescribe productos, y la DB
// es la de producción: acá solo se tocan estas cuatro keys. Es `create if missing`, así
// que correrlo dos veces no revierte un valor que hayas editado a mano en /config.
// Para forzar los valores de esta lista: `tsx scripts/seed-cbm-config.ts --force`.
const db = new PrismaClient()

const CBM_CONFIG = [
  {
    key: 'cbm_rate_usd',
    value: '1000',
    description: 'Tarifa marítima India → Venezuela en USD por m³. Escala lineal: 2 m³ = $2000',
  },
  {
    key: 'cbm_fob_india_usd',
    value: '500',
    description: 'FOB en India: monto FIJO por embarque, no escala con el volumen',
  },
  {
    key: 'cbm_min_m3',
    value: '1',
    description: 'Mínimo facturable de la naviera por embarque (LCL), en m³',
  },
  {
    key: 'cbm_referencia_m3',
    value: '1',
    description: 'Embarque de referencia en m³: sobre este volumen se prorratea el FOB al costear una pieza suelta',
  },
]

async function main() {
  const force = process.argv.includes('--force')

  for (const cfg of CBM_CONFIG) {
    const existing = await db.config.findUnique({ where: { key: cfg.key } })
    if (existing && !force) {
      console.log(`= ${cfg.key.padEnd(20)} ya existe (${existing.value}) — sin cambios`)
      continue
    }
    await db.config.upsert({
      where: { key: cfg.key },
      update: { value: cfg.value, description: cfg.description },
      create: cfg,
    })
    console.log(`${existing ? '↻' : '+'} ${cfg.key.padEnd(20)} = ${cfg.value}`)
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())