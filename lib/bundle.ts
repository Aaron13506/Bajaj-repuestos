// Snapshot de una pieza incluida en un conjunto vendido a precio único.
// Guarda el subgrupo (groupName) para poder mostrarlo en el presupuesto.
export interface BundlePiece {
  nameEs: string
  bajajCode: string | null
  quantity: number
  groupName: string
}

// Agrupa las piezas por subgrupo conservando el orden de aparición.
// Devuelve pares [nombreSubgrupo, piezas]; usa '—' para piezas sin grupo.
export function groupBundlePieces(pieces: BundlePiece[]): [string, BundlePiece[]][] {
  const map = new Map<string, BundlePiece[]>()
  for (const p of pieces) {
    const key = p.groupName || '—'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(p)
  }
  return Array.from(map.entries())
}
