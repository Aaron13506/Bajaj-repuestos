import rates from '@/shipping_rates.json'

interface RateEntry {
  weight_kg: number
  carrier: string
  basic_inr: number
  member_inr: number
}

const byCarrier = new Map<string, RateEntry[]>()
for (const entry of rates as RateEntry[]) {
  if (!byCarrier.has(entry.carrier)) byCarrier.set(entry.carrier, [])
  byCarrier.get(entry.carrier)!.push(entry)
}
Array.from(byCarrier.values()).forEach(arr => {
  arr.sort((a: RateEntry, b: RateEntry) => a.weight_kg - b.weight_kg)
})

export const CARRIER_DUTY_FREE = 'ShipGlobal USA - Duty Free'
export const CARRIER_ECONOMY   = 'Economy Shipping'

export function getShoppReRate(weightKg: number, carrier: string, isMember: boolean): number {
  const table = byCarrier.get(carrier) ?? byCarrier.get(CARRIER_DUTY_FREE)!
  const entry = table.find(e => e.weight_kg >= weightKg) ?? table[table.length - 1]
  return isMember ? entry.member_inr : entry.basic_inr
}
