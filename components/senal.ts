// Confirmación sin mirar la pantalla al contar: un pitido agudo = sumó (1 o una bolsa entera),
// grave = no sumó (hay que mirar). La vibración solo existe en Android.
export type Senal = 'ok' | 'error'

let ctx: AudioContext | null = null

export function senal(tipo: Senal) {
  try {
    ctx ??= new AudioContext()
    void ctx.resume()
    const tonos = tipo === 'error' ? [220] : [1320]
    tonos.forEach((hz, i) => {
      const o = ctx!.createOscillator()
      const g = ctx!.createGain()
      o.frequency.value = hz
      g.gain.value = 0.15
      o.connect(g).connect(ctx!.destination)
      const t = ctx!.currentTime + i * 0.14
      o.start(t)
      o.stop(t + (tipo === 'error' ? 0.3 : 0.08))
    })
  } catch {}
  try { navigator.vibrate?.(tipo === 'error' ? [60, 60, 60] : 60) } catch {}
}
