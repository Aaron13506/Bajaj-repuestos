import { PrismaClient } from '@prisma/client'
import { type MotoModelId } from '@/lib/modelo'

const prisma = new PrismaClient()

// ─────────────────────────────────────────────────────────────────────────────
// Rear Footstep | Pulsar N250 (Single ABS, 2021-23)
//
// El ensamble actúa como "categoría". Cada sub-grupo (Footrest RH/LH, Holder
// RH/LH) es un groupName y cada pieza un Product hijo. Las piezas compartidas
// entre lados (goma, pasador, resorte, bola, chaveta, tornillo) son UN solo
// Product que aparece en varios grupos vía ProductComponent.
//
// Precio: solo se guarda priceInr (moneda de origen). El campo `price` es
// NOT NULL, así que lo poblamos con la CONVERSIÓN directa INR→USD a la tasa
// vigente (Config.inr_usd_rate) — sin margen ni flete. El USD real se calcula
// al momento de mostrar (calcLanded) una vez que la pieza tenga peso.
// ─────────────────────────────────────────────────────────────────────────────

const COMPAT: readonly MotoModelId[] = ['PULSAR_N250_SINGLE_ABS_2021_23']

// Tasa INR→USD leída de Config en main(); fallback al default de calc.ts.
let INR_USD = 95

function toUsd(inr: number): number {
  return Math.round((inr / INR_USD) * 100) / 100
}

interface PartSeed {
  key: string
  bajajCode: string
  nameEn: string
  nameEs: string
  priceInr: number
  notes?: string
}

const parts: PartSeed[] = [
  { key: 'stepRH',   bajajCode: '56JR1957', nameEn: 'Step Pillion RH (Satin Silver)',  nameEs: 'Estribo de pasajero derecho (satén plateado)',   priceInr: 126, notes: 'Ref. alterna: JI113016' },
  { key: 'stepLH',   bajajCode: '56JR1857', nameEn: 'Step Pillion LH (Satin Silver)',  nameEs: 'Estribo de pasajero izquierdo (satén plateado)', priceInr: 126, notes: 'Ref. alterna: JI113014' },
  { key: 'rubber',   bajajCode: 'JL113036', nameEn: 'Rubber Pillion Step',             nameEs: 'Goma de estribo de pasajero',                    priceInr: 16 },
  { key: 'pin',      bajajCode: 'JL113037', nameEn: 'Foot Step Pin',                   nameEs: 'Pasador de estribo',                             priceInr: 10 },
  { key: 'lockRH',   bajajCode: 'JL113032', nameEn: 'Lock Plate RH',                   nameEs: 'Placa de fijación derecha',                      priceInr: 6,  notes: 'Ref. alterna: DT113015' },
  { key: 'lockLH',   bajajCode: 'JL113020', nameEn: 'Lock Plate LH',                   nameEs: 'Placa de fijación izquierda',                    priceInr: 6,  notes: 'Ref. alterna: DT113014' },
  { key: 'spring',   bajajCode: 'GF161143', nameEn: 'Spring – Pillion Footrest',       nameEs: 'Resorte de estribo de pasajero',                 priceInr: 1 },
  { key: 'ball',     bajajCode: 'KMAA0800', nameEn: 'Steel Ball',                      nameEs: 'Bola de acero',                                  priceInr: 1 },
  { key: 'cotter',   bajajCode: 'KHAA2520', nameEn: 'Cotter Pin',                      nameEs: 'Pasador de chaveta',                             priceInr: 1 },
  { key: 'holderRH', bajajCode: '56JR4K57', nameEn: 'Holder Step Pillion RH (Satin Silver)', nameEs: 'Soporte de estribo de pasajero derecho (satén plateado)',   priceInr: 581, notes: 'Ref. alterna: JR113050' },
  { key: 'holderLH', bajajCode: '56JR4J57', nameEn: 'Holder Step Pillion LH (Satin Silver)', nameEs: 'Soporte de estribo de pasajero izquierdo (satén plateado)', priceInr: 579, notes: 'Ref. alterna: JR113048' },
  { key: 'bolt',     bajajCode: 'LAC00185', nameEn: 'Bolt Socket M8x1.25',            nameEs: 'Tornillo Allen M8x1.25',                         priceInr: 18 },
]

// [grupo, key de pieza, cantidad]
const layout: [string, string, number][] = [
  ['Footrest RH', 'stepRH', 1],
  ['Footrest RH', 'rubber', 1],
  ['Footrest RH', 'pin',    1],
  ['Footrest RH', 'lockRH', 1],
  ['Footrest RH', 'spring', 1],
  ['Footrest RH', 'ball',   1],
  ['Footrest RH', 'cotter', 1],
  ['Footrest LH', 'stepLH', 1],
  ['Footrest LH', 'rubber', 1],
  ['Footrest LH', 'pin',    1],
  ['Footrest LH', 'lockLH', 1],
  ['Footrest LH', 'spring', 1],
  ['Footrest LH', 'ball',   1],
  ['Footrest LH', 'cotter', 1],
  ['Holder RH',   'holderRH', 1],
  ['Holder RH',   'bolt',     2],
  ['Holder LH',   'holderLH', 1],
  ['Holder LH',   'bolt',     2],
]

const ASSEMBLY = {
  nameEn: 'Rear Footstep | Pulsar N250 (Single ABS, 2021-23)',
  nameEs: 'Estribo trasero | Pulsar N250 (ABS simple, 2021-23)',
  description: 'Estribo trasero original Bajaj para Pulsar N250 (ABS de canal único, oct 2021 - feb 2023). / Bajaj Genuine Rear Footrest for Pulsar N250 (Single Channel ABS, Oct 2021 - Feb 2023)',
  models: COMPAT,
}

async function upsertByBajajCode(p: {
  bajajCode: string
  nameEn: string
  nameEs: string
  priceInr: number
  price: number
  isAssembly?: boolean
  description?: string | null
  models?: readonly MotoModelId[]
  notes?: string | null
}): Promise<number> {
  const data = {
    nameEs: p.nameEs,
    nameEn: p.nameEn,
    bajajCode: p.bajajCode,
    priceInr: p.priceInr,
    price: p.price,
    isAssembly: p.isAssembly ?? false,
    description: p.description ?? null,
    models: [...(p.models ?? COMPAT)],
    notes: p.notes ?? null,
  }
  const existing = await prisma.product.findFirst({ where: { bajajCode: p.bajajCode } })
  if (existing) {
    await prisma.product.update({ where: { id: existing.id }, data })
    return existing.id
  }
  const created = await prisma.product.create({ data })
  return created.id
}

async function main() {
  // Tasa INR→USD vigente (la misma que usa el cálculo en pantalla)
  const rateRow = await prisma.config.findUnique({ where: { key: 'inr_usd_rate' } })
  INR_USD = parseFloat(rateRow?.value ?? '95') || 95

  // 1) Piezas individuales
  const ids: Record<string, number> = {}
  for (const part of parts) {
    ids[part.key] = await upsertByBajajCode({
      bajajCode: part.bajajCode,
      nameEn: part.nameEn,
      nameEs: part.nameEs,
      priceInr: part.priceInr,
      price: toUsd(part.priceInr),
      notes: part.notes ?? null,
    })
  }

  // 2) Ensamble (find by nameEn para idempotencia, ya que no tiene bajajCode)
  const assemblyPriceInr = parts.reduce((s, p) => {
    const qty = layout.filter(l => l[1] === p.key).reduce((a, [, , q]) => a + q, 0)
    return s + p.priceInr * qty
  }, 0)
  const assemblyPrice = toUsd(assemblyPriceInr)

  let assembly = await prisma.product.findFirst({ where: { nameEn: ASSEMBLY.nameEn } })
  const assemblyData = {
    nameEs: ASSEMBLY.nameEs,
    nameEn: ASSEMBLY.nameEn,
    description: ASSEMBLY.description,
    models: [...ASSEMBLY.models],
    isAssembly: true,
    priceInr: assemblyPriceInr,
    price: assemblyPrice,
  }
  if (assembly) {
    assembly = await prisma.product.update({ where: { id: assembly.id }, data: assemblyData })
  } else {
    assembly = await prisma.product.create({ data: assemblyData })
  }

  // 3) Componentes (upsert por la clave única parentId+childId+groupName)
  let sort = 0
  for (const [groupName, key, quantity] of layout) {
    const childId = ids[key]
    await prisma.productComponent.upsert({
      where: { parentId_childId_groupName: { parentId: assembly.id, childId, groupName } },
      update: { quantity, sortOrder: sort },
      create: { parentId: assembly.id, childId, groupName, quantity, sortOrder: sort },
    })
    sort++
  }

  console.log(`Ensamble "${ASSEMBLY.nameEs}" (#${assembly.id}) listo:`)
  console.log(`  ${parts.length} piezas · ${layout.length} vínculos · INR ${assemblyPriceInr} · venta ~$${assemblyPrice}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
