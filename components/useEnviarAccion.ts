'use client'

import { useRef, useState, useTransition, type FormEvent } from 'react'
import type { ActionResult } from '@/lib/action-result'
import { esRedireccion } from '@/lib/redireccion'

export const ERROR_GENERICO = 'No se pudo completar la acción. Probá de nuevo.'

// El envío manual de un formulario que llama a una server action que puede negarse: sirve a
// los paneles que se abren y cierran (pagos, apertura de caja) y al formulario del libro, que
// no pueden usar `<form action>` porque tienen que decidir QUÉ hacer con el resultado.
//
// Tres reglas, y cada una cierra un bug que ya existía en estos formularios:
//  - Se actúa sobre el resultado: `{ ok: false }` no cierra ni limpia nada y muestra el motivo.
//    Antes el cliente daba por buena cualquier acción que volviera, y un `return` mudo del
//    server cerraba el panel con el dato sin guardar.
//  - El `<form>` se captura ANTES del `await`: React pone `event.currentTarget` en null al
//    terminar el despacho, y `e.currentTarget.reset()` después del `await` reventaba con un
//    TypeError aunque el dato se hubiera guardado.
//  - Un rechazo (la red, el server) también se atrapa y libera el botón: sin el `catch`, el
//    error iba al límite de errores y el formulario quedaba a medias.
//  - `enVuelo` corta un segundo envío aunque llegue antes de que React repinte el botón
//    deshabilitado (Enter repetido): `isPending` recién se ve en el próximo render.
export function useEnviarAccion(
  action: (formData: FormData) => Promise<ActionResult>,
  alExito: (form: HTMLFormElement) => void,
) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const enVuelo = useRef(false)

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (enVuelo.current) return
    enVuelo.current = true
    const form = e.currentTarget
    const fd = new FormData(form)
    setError(null)
    startTransition(async () => {
      try {
        const r = await action(fd)
        if (r.ok) alExito(form)
        else setError(r.error)
      } catch (e) {
        // Una acción que redirige rechaza su promesa a propósito: no es una falla (ver redireccion.ts).
        if (!esRedireccion(e)) setError(ERROR_GENERICO)
      } finally {
        enVuelo.current = false
      }
    })
  }

  return { enviar, isPending, error, limpiarError: () => setError(null) }
}

// Lo mismo para una acción que se dispara desde un control suelto (un select, un botón de
// fila) y no desde un formulario. `startTransition(() => { accion() })` — sin devolver la
// promesa — hacía que `pending` volviera a false al instante (el control no se bloqueaba
// mientras guardaba) y que un rechazo quedara como promesa sin atrapar.
export function useAccionDirecta() {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function ejecutar(accion: () => Promise<ActionResult>) {
    setError(null)
    startTransition(async () => {
      try {
        const r = await accion()
        if (!r.ok) setError(r.error)
      } catch (e) {
        if (!esRedireccion(e)) setError(ERROR_GENERICO)
      }
    })
  }

  return { pending, error, ejecutar }
}
