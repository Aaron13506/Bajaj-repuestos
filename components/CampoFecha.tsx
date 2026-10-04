'use client'

import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import { hoyLocal } from '@/lib/utils'

// <input type="date"> que arranca en la fecha de HOY según el reloj del navegador.
//
// No alcanza con `defaultValue={hoyLocal()}`: estos formularios se renderizan primero en el
// server (Heroku, en UTC), y React NO corrige en la hidratación un atributo que difiere. Con
// eso, desde las 20:00 en Venezuela el campo seguía proponiendo la fecha de mañana. Acá el
// server manda el campo vacío y la fecha local se pone apenas hidrata. Se fija también como
// `defaultValue` del DOM, para que `form.reset()` vuelva a hoy y no a vacío.
//
// Si le pasan `defaultValue` (la fecha de un registro que se está editando), manda ese.
export default function CampoFecha({
  defaultValue,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & { defaultValue?: string }) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || defaultValue) return
    const hoy = hoyLocal()
    el.defaultValue = hoy
    // Si el usuario alcanzó a elegir otra, no se le pisa.
    if (!el.value) el.value = hoy
  }, [defaultValue])

  return <input ref={ref} type="date" defaultValue={defaultValue} {...props} />
}
