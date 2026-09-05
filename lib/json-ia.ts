// ─────────────────────────────────────────────────────────────────────────────
// Rescatar el JSON de una respuesta de IA.
//
// Módulo propio y no una función suelta dentro de lib/measures.ts, que es donde vivía:
// ahí quedaba atada a un archivo que importa la conexión a la base, y cualquier parseo
// que la necesitara —el de la lista de compra, por ejemplo— se arrastraba Prisma entero
// aunque no toque ni una tabla. Acá es lo que es: una función pura de texto.
// ─────────────────────────────────────────────────────────────────────────────

// Extrae el JSON de una respuesta que puede traer razonamiento y fuentes alrededor.
// Prefiere un bloque cercado ```json … ```; si no, balancea desde el primer [ o {
// (respetando strings), así se puede pegar la respuesta completa de la IA.
export function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const src = fence ? fence[1] : raw
  const iArr = src.indexOf('[')
  const iObj = src.indexOf('{')
  let start = -1
  if (iArr >= 0 && (iObj < 0 || iArr < iObj)) start = iArr
  else if (iObj >= 0) start = iObj
  if (start < 0) return src.trim()
  const open = src[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0, inStr = false, esc = false
  for (let j = start; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return src.slice(start, j + 1)
  }
  return src.slice(start).trim()
}
