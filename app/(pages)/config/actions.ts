'use server'

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function saveConfig(formData: FormData) {
  const entries = Array.from(formData.entries()) as [string, string][]
  for (const [key, value] of entries) {
    if (!key || key === '$ACTION_ID') continue
    await db.config.upsert({
      where: { key },
      update: { value: value.trim() },
      create: { key, value: value.trim() },
    })
  }
  revalidatePath('/config')
  revalidatePath('/products')
  redirect('/config?saved=1')
}
