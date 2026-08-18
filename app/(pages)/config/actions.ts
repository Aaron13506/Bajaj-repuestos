'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

// Todos los valores numéricos del Config se leen con parseFloat, que ignora todo
// después de una coma ("96,50" → 96) en vez de tratarla como separador decimal.
// Como acá se usa coma para decimales, normalizamos formatos "96,50" o "1.234,56"
// a notación con punto antes de guardar, para no perder silenciosamente los decimales.
function normalizeDecimalComma(value: string): string {
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(value)) return value.replace(/\./g, '').replace(',', '.')
  if (/^-?\d+,\d+$/.test(value)) return value.replace(',', '.')
  return value
}

export async function saveConfig(formData: FormData) {
  const entries = Array.from(formData.entries()) as [string, string][]
  for (const [key, value] of entries) {
    if (!key || key === '$ACTION_ID') continue
    const normalized = normalizeDecimalComma(value.trim())
    await db.config.upsert({
      where: { key },
      update: { value: normalized },
      create: { key, value: normalized },
    })
  }
  // Las tarifas del Config entran en el landed de cada pieza, así que un cambio acá
  // repercute en catálogo, ensambles, presupuestos y envíos por igual.
  revalidatePath('/', 'layout')
  redirect('/config?saved=1')
}
