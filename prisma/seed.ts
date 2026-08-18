import { PrismaClient } from '@prisma/client'
import { type MotoModelId } from '@/lib/modelo'

// Motos de cada pieza del seed, con los ids del enum. Antes era texto libre
// ("Pulsar N250/N160") que no era ningún modelo del catálogo; ver lib/modelo.ts.
const N250: MotoModelId[] = ['PULSAR_N250_SINGLE_ABS_2021_23', 'PULSAR_N250_DUAL_ABS_2022_23', 'PULSAR_N250_USD_FORK_2024_25']
const N160: MotoModelId[] = ['PULSAR_N160_SINGLE_ABS_2022_23', 'PULSAR_N160_DUAL_ABS_2022_23']
const NS200: MotoModelId[] = ['PULSAR_NS200_BS4_2017_19', 'PULSAR_NS200_BS6_2020', 'PULSAR_NS200_BS6_2021_23', 'PULSAR_NS200_USD_FORK_2023']
const P150: MotoModelId[] = ['PULSAR_150_BS4', 'PULSAR_150_UG4']
const N250_N160: MotoModelId[] = [...N250, ...N160]
const N250_N160_NS200: MotoModelId[] = [...N250, ...N160, ...NS200]


const prisma = new PrismaClient()

const configs = [
  { key: 'inr_usd_rate',           value: '95',    description: 'Rupias indias por 1 USD — actualizar según XE.com' },
  { key: 'bsd_usd_rate',           value: '715',   description: 'BsD por 1 USD — BCV o paralelo' },
  { key: 'shoppre_member',         value: 'true',  description: 'true si tenés membresía Shoppre (aplica tarifa con descuento)' },
  { key: 'reference_weight_kg',    value: '15',    description: 'Peso de referencia en kg para prorratear envío en el catálogo' },
  { key: 'air_volumetric_divisor', value: '5000',  description: 'Divisor para peso volumétrico aéreo: vol_kg = L×A×H(cm) / divisor (Shoppre/ShipGlobal suele ser 5000)' },
  { key: 'miami_caracas_per_ft3',  value: '45',    description: 'Costo marítimo Miami → Caracas en USD/ft³' },
  { key: 'shoppre_insurance_pct',  value: '0.03',  description: 'Seguro Shoppre: 3% sobre el valor declarado' },
  { key: 'shoppre_processing_inr', value: '500',   description: 'Processing fee fijo de Shoppre por envío (INR)' },
  { key: 'shoppre_carrier',        value: 'ShipGlobal USA - Duty Free', description: 'Transportista Shoppre: "ShipGlobal USA - Duty Free" o "Economy Shipping"' },
  { key: 'default_margin_pct',     value: '40',    description: 'Margen de ganancia por defecto (%) al crear un producto; el precio se calcula solo y luego se puede ajustar' },
  // Modo Marítimo CBM — India → Venezuela directo por mar. Solo aplican con ese modo activo.
  { key: 'cbm_rate_usd',           value: '1000',  description: 'Tarifa plana India → Venezuela en USD por m³ (incluye flete, seguro, origen, destino y aduana). Escala lineal: 2 m³ = 2000' },
  { key: 'cbm_fob_india_usd',      value: '500',   description: 'FOB en India: monto fijo por embarque, no escala con el volumen' },
  { key: 'cbm_min_m3',             value: '1',     description: 'Mínimo facturable de la naviera en m³ por embarque (LCL)' },
  { key: 'cbm_referencia_m3',      value: '1',     description: 'Embarque de referencia en m³ para prorratear el FOB al costear una pieza suelta en el catálogo' },
]

const products = [
  {
    nameEs: 'Kit cadena (cadena + 2 catarinas)',
    bajajCode: '36JR0033',
    models: [...N250],
    weightGrams: 3052, dimL: 25, dimA: 20, dimH: 8,
    priceInr: 2295, landedCostUsd: 81.96, margin: 0.40, price: 137,
    notes: 'Kit Chain Sprocket — chain 428 + corona trasera + piñón delantero. Peso medido real.',
  },
  {
    nameEs: 'Bujía NGK (x1)',
    bajajCode: 'JL351218',
    models: [...N250],
    weightGrams: 50, dimL: 6, dimA: 4, dimH: 4,
    priceInr: 155, landedCostUsd: 2.66, margin: 0.40, price: 4,
    notes: 'Plug Spark — también ref JL351217. Incluir en regalos/kits, no vender sola.',
  },
  {
    nameEs: 'Bujía Bosch RG6HCC (x1)',
    bajajCode: 'DK111028',
    models: [...N250],
    weightGrams: 40, dimL: 6, dimA: 4, dimH: 4,
    priceInr: 120, landedCostUsd: 2.11, margin: 0.40, price: 4,
    notes: 'Spark Plug RG6HCC — también ref DT351206.',
  },
  {
    nameEs: 'Filtro aire (kit elemento + sello)',
    bajajCode: '36JR0043',
    models: [...N250_N160],
    weightGrams: 180, dimL: 15, dimA: 12, dimH: 5,
    priceInr: 251, landedCostUsd: 7.14, margin: 0.40, price: 12,
    notes: 'Kit Air Filter Element + Seal — completo.',
  },
  {
    nameEs: 'Filtro aceite (x1)',
    bajajCode: 'JG571014',
    models: [...N250_N160_NS200],
    weightGrams: 85, dimL: 8, dimA: 7, dimH: 6,
    priceInr: 82, landedCostUsd: 2.83, margin: 0.40, price: 5,
    notes: 'Oil Filter + O-Ring LJA00022. Usar como regalo en pedidos grandes. El O-ring solo sirve para N250 y N160.',
  },
  {
    nameEs: 'Empaque tapa válvulas',
    bajajCode: 'PD511096',
    models: [...N250],
    weightGrams: 50, dimL: 20, dimA: 15, dimH: 1,
    priceInr: 44, landedCostUsd: 1.95, margin: 0.40, price: 3,
    notes: 'Gasket Cover Head Cylinder — pieza pequeña, incluir en kits de mantenimiento mayor.',
  },
  {
    nameEs: 'Pastillas freno delantero',
    bajajCode: 'JR131827',
    models: [...N250_N160],
    weightGrams: 150, dimL: 12, dimA: 8, dimH: 4,
    priceInr: 256, landedCostUsd: 5.87, margin: 0.40, price: 10,
    notes: 'Pad Set Brake Front.',
  },
  {
    nameEs: 'Pastillas freno trasero',
    bajajCode: '36DH4174',
    models: [...N250_N160],
    weightGrams: 130, dimL: 10, dimA: 7, dimH: 4,
    priceInr: 237, landedCostUsd: 5.16, margin: 0.40, price: 9,
    notes: 'Disc Pad Set Rear Caliper Endu.',
  },
  {
    nameEs: 'Cable embrague',
    bajajCode: 'JR161206',
    models: [...N250_N160],
    weightGrams: 160, dimL: 120, dimA: 2, dimH: 2,
    priceInr: 229, landedCostUsd: 5.90, margin: 0.40, price: 10,
    notes: 'Cable Clutch.',
  },
  {
    nameEs: 'Kit cadena N160',
    bajajCode: 'JR161207',
    models: [...N160],
    weightGrams: 2400, dimL: 21, dimA: 17, dimH: 7,
    priceInr: 2000, landedCostUsd: 65.54, margin: 0.25, price: 87,
    notes: 'Kit de cadena N160.',
  },
  {
    nameEs: 'Bomba de freno maestro',
    bajajCode: 'JR131882',
    models: [...N250],
    weightGrams: 600, dimL: 22, dimA: 14, dimH: 10,
    priceInr: 1229, landedCostUsd: 28.46, margin: 0.40, price: 47,
    notes: null,
  },
  {
    nameEs: 'Kit bujías',
    bajajCode: 'DG111008',
    models: [...P150],
    weightGrams: 80, dimL: 12, dimA: 4, dimH: 4,
    priceInr: 232, landedCostUsd: 4.15, margin: 0.40, price: 7,
    notes: null,
  },
  {
    nameEs: 'Filtro de gasolina',
    bajajCode: null,
    models: [...N250],
    weightGrams: 100, dimL: 10, dimA: 10, dimH: 5,
    priceInr: 100, landedCostUsd: 3.53, margin: 0.40, price: 6,
    notes: null,
  },
  {
    nameEs: 'Tapa belly RH',
    bajajCode: '52JR0131',
    models: [...N250],
    weightGrams: 200, dimL: 22, dimA: 14, dimH: 4,
    priceInr: 275, landedCostUsd: 9.04, margin: 0.40, price: 15,
    notes: null,
  },
  {
    nameEs: 'Lockset',
    bajajCode: '36JR0125',
    models: [...N250],
    weightGrams: 1000, dimL: 22, dimA: 16, dimH: 10,
    priceInr: 1867, landedCostUsd: 42.45, margin: 0.40, price: 71,
    notes: null,
  },
  {
    nameEs: 'Spark plug cap',
    bajajCode: 'DH111015',
    models: [...N250],
    weightGrams: 70, dimL: 8, dimA: 6, dimH: 5,
    priceInr: 242, landedCostUsd: 4.17, margin: 0.40, price: 7,
    notes: null,
  },
  {
    nameEs: 'Sensores 3 en 1',
    bajajCode: '36DP0112',
    models: [...N250],
    weightGrams: 70, dimL: 8, dimA: 6, dimH: 5,
    priceInr: 1155, landedCostUsd: 14.06, margin: 0.40, price: 23,
    notes: 'TPS, MAP sensor o MAT, IAT.',
  },
  {
    nameEs: 'Tacómetro',
    bajajCode: 'JR402412',
    models: [...N250],
    weightGrams: 60, dimL: 16, dimA: 12, dimH: 5,
    priceInr: 70, landedCostUsd: 5.48, margin: 0.30, price: 8,
    notes: null,
  },
]

async function main() {
  // Configs — siempre upsert
  for (const cfg of configs) {
    await prisma.config.upsert({
      where: { key: cfg.key },
      update: { value: cfg.value, description: cfg.description },
      create: cfg,
    })
  }

  // Productos — solo insertar si la tabla está vacía
  const existing = await prisma.product.count()
  if (existing === 0) {
    await prisma.product.createMany({ data: products })
    console.log(`Seed: ${products.length} productos insertados.`)
  } else {
    console.log(`Seed: productos omitidos (ya hay ${existing} en la DB).`)
  }

  console.log('Seed completado.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
