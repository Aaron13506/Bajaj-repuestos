import { PrismaClient } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// Rescata la compatibilidad con la Boxer BM150 desde la columna huérfana Product.models
// hacia Product.compatibleModels, que es lo que la app lee de verdad.
//
// Contexto: hubo un intento de tipar las motos con un enum (`Product.models`). Ese trabajo
// quedó aplicado en la DB pero su schema nunca se commiteó, así que hoy la columna existe
// con datos y ningún código la lee. El texto `compatibleModels` es un espejo fiel de ella
// PARA LAS PULSAR — pero la Boxer entró al catálogo después del backfill original y quedó
// solo en el enum: 598 productos la tienen en `models` y ninguno la menciona en el texto.
//
// Sin esto, dropear la columna dejaría 436 productos sin ninguna moto asociada, invisibles
// para el filtro del catálogo y del armador de presupuestos.
//
// Idempotente: el guardia NOT ILIKE '%Boxer%' hace que correrlo dos veces no duplique nada.
//
//   pnpm backfill:boxer           → dry-run, no escribe
//   pnpm backfill:boxer --apply   → escribe
// ─────────────────────────────────────────────────────────────────────────────

const db = new PrismaClient()

// Etiqueta legible del enum, en el mismo formato que el resto (PULSAR_150_BS4 →
// "Pulsar 150 BS4"). Va al principio de la lista porque el texto está ordenado
// alfabéticamente y "Boxer" precede a "Pulsar".
const LABEL = 'Boxer BM150'

// Valor del enum → etiqueta canónica. La conversión NO es mecánica ("Single" va en
// capital inicial pero "ABS" y "USD" van enteras en mayúscula), así que se escribe a mano
// y tiene que coincidir exacto con MODEL_ORDER de lib/catalog.ts — de ahí sale el
// dropdown del filtro, y una etiqueta que no esté en esa lista aparece como un modelo
// aparte (que es justo el desorden que este rescate viene a evitar).
const ETIQUETA: Record<string, string> = {
  PULSAR_150_BS4: 'Pulsar 150 BS4',
  PULSAR_150_UG4: 'Pulsar 150 UG4',
  PULSAR_180_BS3_2009_16_UG4: 'Pulsar 180 BS3 2009 16 UG4',
  PULSAR_180_BS4_2017_19: 'Pulsar 180 BS4 2017 19',
  PULSAR_200NS_BS3_2012_16: 'Pulsar 200NS BS3 2012 16',
  PULSAR_NS200_BS4_2017_19: 'Pulsar NS200 BS4 2017 19',
  PULSAR_NS200_BS6_2020: 'Pulsar NS200 BS6 2020',
  PULSAR_NS200_BS6_2021_23: 'Pulsar NS200 BS6 2021 23',
  PULSAR_NS200_USD_FORK_2023: 'Pulsar NS200 USD Fork 2023',
  PULSAR_N160_SINGLE_ABS_2022_23: 'Pulsar N160 Single ABS 2022 23',
  PULSAR_N160_DUAL_ABS_2022_23: 'Pulsar N160 Dual ABS 2022 23',
  PULSAR_N250_SINGLE_ABS_2021_23: 'Pulsar N250 Single ABS 2021 23',
  PULSAR_N250_DUAL_ABS_2022_23: 'Pulsar N250 Dual ABS 2022 23',
  PULSAR_N250_USD_FORK_2024_25: 'Pulsar N250 USD Fork 2024 25',
  BOXER_BM150: LABEL,
}

// Segunda pasada: cualquier producto al que el enum le sepa la moto y el texto no. Después
// de la Boxer quedan poquísimos (piezas que heredan el modelo de su ensamble), pero
// mientras exista uno solo la columna `models` sigue guardando algo único y dropearla
// perdería información.
async function rescatarResto(db: PrismaClient, apply: boolean): Promise<number> {
  const filas = await db.$queryRawUnsafe<{ id: number; nameEs: string; modelos: string[] }[]>(`
    SELECT id, "nameEs", "models"::text[] AS modelos
    FROM "Product" WHERE array_length("models",1) > 0 AND "compatibleModels" IS NULL`)
  if (filas.length === 0) return 0

  console.log(`\nSin Boxer, todavía sin texto: ${filas.length}`)
  for (const f of filas) {
    // Alfabético, igual que el resto de los textos ya existentes.
    const etiquetas = f.modelos.map(m => ETIQUETA[m]).filter(Boolean).sort((a, b) => a.localeCompare(b))
    if (etiquetas.length !== f.modelos.length) {
      console.log(`  ⚠ ${f.nameEs} (#${f.id}): valor de enum sin etiqueta conocida → ${f.modelos.join(',')}`)
      continue
    }
    const texto = etiquetas.join(', ')
    console.log(`  ${apply ? '✓' : '·'} #${f.id} ${f.nameEs} → ${texto}`)
    if (apply) await db.product.update({ where: { id: f.id }, data: { compatibleModels: texto } })
  }
  return filas.length
}

// Tercera pasada: productos cuyo texto es un ALIAS ("N250", "N250/N160", "Pulsar N250")
// que el enum había resuelto a las variantes concretas. Acá el enum es estrictamente más
// preciso que el texto, así que el texto se reescribe con la expansión canónica — si no,
// dropear la columna perdería esa precisión y el filtro seguiría mostrando modelos que no
// existen en el catálogo.
async function expandirAlias(db: PrismaClient, apply: boolean): Promise<number> {
  const filas = await db.$queryRawUnsafe<{ id: number; nameEs: string; modelos: string[]; texto: string }[]>(`
    SELECT id, "nameEs", "models"::text[] AS modelos, "compatibleModels" AS texto
    FROM "Product"
    WHERE array_length("models",1) > 0 AND "compatibleModels" IS NOT NULL
    ORDER BY id`)

  const pendientes = filas.filter(f => {
    const etiquetas = f.modelos.map(m => ETIQUETA[m]).filter(Boolean)
    return etiquetas.length > 0 && etiquetas.some(e => !f.texto.includes(e))
  })
  if (pendientes.length === 0) return 0

  console.log(`\nTextos con alias que el enum resuelve mejor: ${pendientes.length}`)
  for (const f of pendientes) {
    const texto = f.modelos
      .map(m => ETIQUETA[m])
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join(', ')
    console.log(`  ${apply ? '✓' : '·'} #${f.id} ${f.nameEs}`)
    console.log(`      "${f.texto}" → "${texto}"`)
    if (apply) await db.product.update({ where: { id: f.id }, data: { compatibleModels: texto } })
  }
  return pendientes.length
}

async function main() {
  const apply = process.argv.includes('--apply')

  const [antes] = await db.$queryRawUnsafe<{ sin_texto: number; compartidos: number; ya_ok: number }[]>(`
    SELECT
      count(*) FILTER (WHERE "compatibleModels" IS NULL)::int AS sin_texto,
      count(*) FILTER (WHERE "compatibleModels" IS NOT NULL AND "compatibleModels" NOT ILIKE '%boxer%')::int AS compartidos,
      count(*) FILTER (WHERE "compatibleModels" ILIKE '%boxer%')::int AS ya_ok
    FROM "Product" WHERE 'BOXER_BM150' = ANY("models")`)

  console.log(`Productos con BOXER_BM150 en el enum: ${antes.sin_texto + antes.compartidos + antes.ya_ok}`)
  console.log(`  sin compatibleModels (solo Boxer) : ${antes.sin_texto}  → se les pone "${LABEL}"`)
  console.log(`  con texto de Pulsar (compartidos) : ${antes.compartidos}  → se les antepone "${LABEL}, "`)
  console.log(`  ya mencionan Boxer                : ${antes.ya_ok}  → sin cambios`)

  if (!apply) {
    const muestra = await db.$queryRawUnsafe<{ nameEs: string; antes: string | null; despues: string }[]>(`
      SELECT "nameEs",
             "compatibleModels" AS antes,
             CASE WHEN "compatibleModels" IS NULL THEN '${LABEL}'
                  ELSE '${LABEL}, ' || "compatibleModels" END AS despues
      FROM "Product"
      WHERE 'BOXER_BM150' = ANY("models") AND "compatibleModels" NOT ILIKE '%boxer%' OR
            ('BOXER_BM150' = ANY("models") AND "compatibleModels" IS NULL)
      LIMIT 4`)
    console.log('\nMuestra del cambio:')
    for (const m of muestra) {
      console.log(`  ${m.nameEs}`)
      console.log(`    antes  : ${m.antes ?? '(vacío)'}`)
      console.log(`    después: ${m.despues.slice(0, 100)}${m.despues.length > 100 ? '…' : ''}`)
    }
    await rescatarResto(db, false)
    await expandirAlias(db, false)
    console.log('\nDRY-RUN. Nada escrito. Volvé a correr con --apply para aplicarlo.')
    return
  }

  // Solo Boxer: el texto pasa a ser la etiqueta sola.
  const soloBoxer = await db.$executeRawUnsafe(`
    UPDATE "Product" SET "compatibleModels" = $1
    WHERE 'BOXER_BM150' = ANY("models") AND "compatibleModels" IS NULL`, LABEL)

  // Compartidos con Pulsar: se antepone, que es donde cae alfabéticamente.
  const compartidos = await db.$executeRawUnsafe(`
    UPDATE "Product" SET "compatibleModels" = $1 || ', ' || "compatibleModels"
    WHERE 'BOXER_BM150' = ANY("models")
      AND "compatibleModels" IS NOT NULL
      AND "compatibleModels" NOT ILIKE '%boxer%'`, LABEL)

  console.log(`\n✓ ${soloBoxer} productos solo-Boxer actualizados`)
  console.log(`✓ ${compartidos} productos compartidos actualizados`)

  await rescatarResto(db, true)
  await expandirAlias(db, true)

  const [despues] = await db.$queryRawUnsafe<{ n: number; falta: number }[]>(`
    SELECT count(*) FILTER (WHERE "compatibleModels" ILIKE '%boxer%')::int AS n,
           count(*) FILTER (WHERE "compatibleModels" IS NULL)::int AS falta
    FROM "Product" WHERE 'BOXER_BM150' = ANY("models")`)
  console.log(`\nVerificación: ${despues.n} con Boxer en el texto, ${despues.falta} todavía sin texto.`)
  console.log(despues.falta === 0
    ? 'La columna "models" ya no guarda nada que no esté en "compatibleModels".'
    : 'OJO: quedaron filas sin texto, revisar antes de dropear.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
