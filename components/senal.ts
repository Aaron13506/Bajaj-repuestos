// Confirmación sin mirar la pantalla al contar:
//   ok        1 pitido agudo corto = sumó (todavía faltan)
//   completa  1 pitido agudo largo = fila completa
//   sobra     doble pitido + vibración larga = te pasaste (sobra)
//   error     pitido grave = no sumó (hay que mirar)
// La vibración solo existe en Android.
export type Senal = 'ok' | 'completa' | 'sobra' | 'error'

let ctx: AudioContext | null = null

const CONFIG: Record<Senal, { tonos: number[]; duracion: number; paso: number; vibrar: number | number[] }> = {
  ok: { tonos: [1320], duracion: 0.08, paso: 0.14, vibrar: 60 },
  completa: { tonos: [1560], duracion: 0.22, paso: 0.14, vibrar: 100 },
  sobra: { tonos: [880, 880], duracion: 0.11, paso: 0.15, vibrar: [120, 70, 220] },
  error: { tonos: [220], duracion: 0.3, paso: 0.14, vibrar: [60, 60, 60] },
}

export function senal(tipo: Senal) {
  const c = CONFIG[tipo]
  try {
    ctx ??= new AudioContext()
    void ctx.resume()
    c.tonos.forEach((hz, i) => {
      const o = ctx!.createOscillator()
      const g = ctx!.createGain()
      o.frequency.value = hz
      g.gain.value = 0.15
      o.connect(g).connect(ctx!.destination)
      const t = ctx!.currentTime + i * c.paso
      o.start(t)
      o.stop(t + c.duracion)
    })
  } catch {}
  try { navigator.vibrate?.(c.vibrar) } catch {}
}
