// Valor por piezas de cada moto: recorre los ensambles de cada modelo, expande sus
// componentes (con anidamiento) y suma el costo de origen de cada pieza por cantidad.
import { db } from '../lib/db'
import { calcLanded } from '../lib/calc'
import { parseModelos, modelosDistintos } from '../lib/modelos'
import { sortModels } from '../lib/catalog'

interface Nodo {
  id: number
  isAssembly: boolean
  nameEs: string
  bajajCode: string | null
  compatibleModels: string | null
  priceInr: number | null
  weightGrams: number | null
  dimL: number | null
  dimA: number | null
  dimH: number | null
  margin: number | null
  price: number
}

async function main() {
  const cfg = Object.fromEntries((await db.config.findMany()).map(c => [c.key, c.value]))
  const inrUsd = parseFloat(cfg.inr_usd_rate ?? '95')

  const prods = await db.product.findMany({
    select: {
      id: true, isAssembly: true, nameEs: true, bajajCode: true, compatibleModels: true,
      priceInr: true, weightGrams: true, dimL: true, dimA: true, dimH: true, margin: true, price: true,
    },
  })
  const byId = new Map<number, Nodo>(
    prods.map(p => [p.id, { ...p, price: Number(p.price) } as Nodo]),
  )

  const links = await db.productComponent.findMany({
    select: { parentId: true, childId: true, quantity: true },
  })
  const hijos = new Map<number, { childId: number; quantity: number }[]>()
  for (const l of links) {
    const arr = hijos.get(l.parentId) ?? []
    arr.push({ childId: l.childId, quantity: l.quantity })
    hijos.set(l.parentId, arr)
  }

  // Expande un ensamble a piezas hoja con su cantidad acumulada. Corta ciclos.
  function expandir(rootId: number): Map<number, number> {
    const out = new Map<number, number>()
    const walk = (id: number, mult: number, path: Set<number>) => {
      const kids = hijos.get(id)
      if (!kids?.length) {
        out.set(id, (out.get(id) ?? 0) + mult)
        return
      }
      if (path.has(id)) return
      const next = new Set(path).add(id)
      for (const k of kids) walk(k.childId, mult * k.quantity, next)
    }
    for (const k of hijos.get(rootId) ?? []) walk(k.childId, k.quantity, new Set([rootId]))
    return out
  }

  // ── Factor observado landed/origen, sobre las piezas que SÍ tienen medidas ──
  let origenMedido = 0, landedMedido = 0, nMedidas = 0
  for (const p of prods) {
    if (p.isAssembly || !p.priceInr) continue
    const l = calcLanded({ ...p, margin: p.margin }, cfg, 'aereo')
    if (!l) continue
    origenMedido += l.productCostUsd
    landedMedido += l.landedCostUsd
    nMedidas++
  }
  const factorLanded = landedMedido / origenMedido

  const ensambles = prods.filter(p => p.isAssembly)
  const modelos = sortModels(modelosDistintos(ensambles.map(e => e.compatibleModels)))

  interface Fila {
    modelo: string
    ensambles: number
    piezas: number       // unidades (cantidad sumada)
    skus: number         // SKU distintos
    origenUsd: number
    conMedidas: number   // unidades con peso+dim
    ventaUsd: number     // precio de venta aplicando margen sobre landed estimado
    sinInr: number
  }
  const filas: Fila[] = []
  const detalle = new Map<string, { nombre: string; code: string | null; piezas: number; origenUsd: number }[]>()

  for (const modelo of modelos) {
    const asms = ensambles.filter(e => parseModelos(e.compatibleModels).includes(modelo))
    const acumSku = new Map<number, number>()
    const det: { nombre: string; code: string | null; piezas: number; origenUsd: number }[] = []

    for (const a of asms) {
      const piezas = expandir(a.id)
      let costoAsm = 0, unidades = 0
      for (const [pid, qty] of piezas) {
        const p = byId.get(pid)
        if (!p) continue
        unidades += qty
        acumSku.set(pid, (acumSku.get(pid) ?? 0) + qty)
        if (p.priceInr) costoAsm += (p.priceInr / inrUsd) * qty
      }
      det.push({ nombre: a.nameEs, code: a.bajajCode, piezas: unidades, origenUsd: costoAsm })
    }

    let piezas = 0, origenUsd = 0, conMedidas = 0, ventaUsd = 0, sinInr = 0
    for (const [pid, qty] of acumSku) {
      const p = byId.get(pid)
      if (!p) continue
      piezas += qty
      if (!p.priceInr) { sinInr += qty; continue }
      const origen = (p.priceInr / inrUsd) * qty
      origenUsd += origen
      const tieneMedidas = !!(p.weightGrams && p.dimL && p.dimA && p.dimH)
      if (tieneMedidas) conMedidas += qty
      // Landed: real si hay medidas, estimado por el factor observado si no.
      const l = tieneMedidas ? calcLanded(p, cfg, 'aereo') : null
      const landed = l ? l.landedCostUsd * qty : origen * factorLanded
      const margen = p.margin
      ventaUsd += margen != null && margen < 1 ? landed / (1 - margen) : landed
    }

    filas.push({ modelo, ensambles: asms.length, piezas, skus: acumSku.size, origenUsd, conMedidas, ventaUsd, sinInr })
    detalle.set(modelo, det.sort((a, b) => b.origenUsd - a.origenUsd))
  }

  console.log(`\nFX: ₹${inrUsd}/USD · factor landed/origen observado: ${factorLanded.toFixed(3)}x (sobre ${nMedidas} piezas con medidas)\n`)
  console.log('MODELO'.padEnd(34), 'ENS'.padStart(5), 'SKU'.padStart(6), 'PIEZAS'.padStart(7), 'ORIGEN USD'.padStart(12), 'MEDIDAS'.padStart(8), 'VENTA USD'.padStart(12))
  for (const f of filas.sort((a, b) => b.origenUsd - a.origenUsd)) {
    console.log(
      f.modelo.padEnd(34),
      String(f.ensambles).padStart(5),
      String(f.skus).padStart(6),
      String(f.piezas).padStart(7),
      f.origenUsd.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12),
      `${Math.round((f.conMedidas / f.piezas) * 100)}%`.padStart(8),
      f.ventaUsd.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12),
      f.sinInr ? `  (${f.sinInr} sin ₹)` : '',
    )
  }

  // Top ensambles por modelo
  console.log('\n── Ensambles más caros por modelo (costo origen USD) ──')
  for (const f of filas) {
    const det = detalle.get(f.modelo)!
    console.log(`\n${f.modelo}`)
    for (const d of det.slice(0, 8)) {
      console.log(`   ${d.origenUsd.toFixed(0).padStart(7)}  ${String(d.piezas).padStart(4)} pz  ${d.nombre.slice(0, 60)}`)
    }
  }
}
main().finally(() => db.$disconnect())
