'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BarcodeDetector as Detector } from 'barcode-detector/ponyfill'
import type { Senal } from './senal'

const FORMATOS = ['qr_code', 'code_128'] as const
// La misma etiqueta vuelve a contar cuando dejó de verse este tiempo: el hueco natural al
// cambiar una caja por la siguiente (diez filtros iguales seguidos). Se ajusta en el depósito.
const REARME_MS = 300
// Y nunca antes de este tiempo desde que se contó: un parpadeo de la detección contaba doble.
const ENFRIAMIENTO_MS = 1500
// En modo gatillo, cuánto espera una etiqueta después de tocar el botón.
const GATILLO_MS = 1500

// Cámara del teléfono a pantalla completa leyendo QR (cajas de Bajaj) y Code 128 (bolsas del
// proveedor). Cada lectura nueva llama a `onLectura`, que devuelve cómo le fue para el destello
// del borde (puede ser una promesa: Consultar espera al servidor para saber si la encontró).
// `encabezado` queda fijo arriba, `children` ocupa el panel con scroll y `pie` queda fijo abajo.
export default function LectorCamara({
  onLectura,
  onCerrar,
  encabezado,
  pie,
  children,
}: {
  onLectura: (raw: string) => Senal | Promise<Senal>
  onCerrar: () => void
  encabezado?: ReactNode
  pie?: ReactNode
  children?: ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<MediaStreamTrack | null>(null)
  // El callback cambia en cada render del padre (lee su conteo): el bucle usa siempre el último.
  const cb = useRef(onLectura)
  useEffect(() => { cb.current = onLectura })
  const gatillo = useRef<{ activo: boolean; hasta: number }>({ activo: false, hasta: 0 })
  const [modoGatillo, setModoGatillo] = useState(false)
  const modoGatilloRef = useRef(false)
  useEffect(() => { modoGatilloRef.current = modoGatillo }, [modoGatillo])
  const [linterna, setLinterna] = useState<boolean | null>(null) // null = el track no la soporta
  const [flash, setFlash] = useState<Senal | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Solo en `pnpm dev`: una lectura tecleada entra por el mismo camino que la cámara (probar la pantalla sin etiquetas).
  const simular = useRef<((raw: string) => void) | null>(null)

  useEffect(() => {
    let vivo = true
    let stream: MediaStream | null = null
    let raf = 0
    let apagarFlash = 0
    const vistos = new Map<string, number>() // raw → última vez que se vio
    const emitidos = new Map<string, number>() // raw → última vez que se contó
    const emitir = async (raw: string) => {
      let r: Senal
      try { r = await cb.current(raw) } catch { r = 'error' }
      if (!vivo) return
      setFlash(r)
      clearTimeout(apagarFlash)
      apagarFlash = window.setTimeout(() => setFlash(null), 250)
    }
    simular.current = raw => void emitir(raw)
    ;(async () => {
      try {
        // Sin resolución pedida, el navegador da 640×480 y se ve pixelado al estirarlo a pantalla completa.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (!vivo) return
        const v = video.current!
        v.srcObject = stream
        await v.play()
        track.current = stream.getVideoTracks()[0]
        const caps = track.current.getCapabilities?.() as { torch?: boolean; focusMode?: string[] } | undefined
        setLinterna(caps?.torch ? false : null)
        // Algunos Android arrancan con el foco fijo: se pide autofoco continuo si el track lo ofrece.
        if (caps?.focusMode?.includes('continuous')) {
          await track.current.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
        }

        // El nativo (Chrome Android) si lee los dos formatos; si no, el ponyfill sobre zxing-wasm (Safari).
        // shortcut: el .wasm del ponyfill se baja de jsDelivr; servirlo desde /public si el depósito no tiene salida a internet.
        const nativo = (globalThis as { BarcodeDetector?: typeof Detector }).BarcodeDetector
        const soporta: readonly string[] = nativo ? await nativo.getSupportedFormats().catch(() => []) : []
        const Clase = nativo && FORMATOS.every(f => soporta.includes(f)) ? nativo : (await import('barcode-detector/ponyfill')).BarcodeDetector
        const det = new Clase({ formats: [...FORMATOS] })

        const tick = async () => {
          if (!vivo) return
          try {
            const ahora = performance.now()
            const raws = [...new Set((await det.detect(v)).map(c => c.rawValue).filter(Boolean))]
            const g = gatillo.current
            if (g.activo) {
              if (raws.length > 0) { g.activo = false; void emitir(raws[0]) }
              else if (ahora > g.hasta) { g.activo = false; void emitir('') }
            }
            for (const raw of raws) {
              const antes = vistos.get(raw)
              vistos.set(raw, ahora)
              const contado = emitidos.get(raw)
              if (!g.activo && !modoGatilloRef.current && (antes == null || ahora - antes > REARME_MS) && (contado == null || ahora - contado > ENFRIAMIENTO_MS)) {
                emitidos.set(raw, ahora)
                void emitir(raw)
              }
            }
          } catch {}
          if (vivo) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch (e) {
        if (!vivo) return
        setError(!window.isSecureContext
          ? 'La cámara necesita HTTPS: entrá por el nombre .ts.net, no por la IP.'
          : e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'No hay permiso para usar la cámara. Habilitalo en el navegador.'
            : 'No se pudo abrir la cámara.')
      }
    })()
    return () => {
      vivo = false
      cancelAnimationFrame(raf)
      clearTimeout(apagarFlash)
      stream?.getTracks().forEach(t => t.stop()) // si no, la cámara queda encendida
    }
  }, [])

  // Pantalla encendida mientras la cámara está abierta. El navegador suelta el bloqueo al
  // ocultarse la pestaña, así que se vuelve a pedir al volver.
  useEffect(() => {
    let vivo = true
    let lock: WakeLockSentinel | null = null
    const pedir = () => {
      if (document.visibilityState !== 'visible' || !navigator.wakeLock) return
      navigator.wakeLock.request('screen').then(l => { if (vivo) lock = l; else void l.release() }, () => {})
    }
    pedir()
    document.addEventListener('visibilitychange', pedir)
    return () => {
      vivo = false
      document.removeEventListener('visibilitychange', pedir)
      void lock?.release().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onCerrar])

  async function alternarLinterna() {
    if (!track.current || linterna == null) return
    try {
      await track.current.applyConstraints({ advanced: [{ torch: !linterna } as MediaTrackConstraintSet] })
      setLinterna(!linterna)
    } catch { setLinterna(null) }
  }

  const borde = flash === 'ok' ? 'border-green-500'
    : flash === 'completa' ? 'border-emerald-500'
      : flash === 'sobra' ? 'border-amber-500'
        : flash === 'error' ? 'border-red-600'
          : 'border-transparent'

  const iconoBtn = 'flex h-11 w-11 items-center justify-center rounded-full shadow-sm transition-colors'

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Escanear con la cámara" className={`fixed inset-0 z-50 flex flex-col bg-black border-4 ${borde}`}>
      {encabezado && <div className="shrink-0 border-b border-gray-200 bg-white">{encabezado}</div>}
      {/* overflow-hidden: la sombra del recuadro (9999px) no debe oscurecer el panel de abajo */}
      <div className={`relative overflow-hidden bg-black ${children ? 'h-[32dvh] min-h-[190px] shrink-0' : 'flex-1 min-h-0'}`}>
        <video ref={video} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
        <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-[66%] max-h-44 w-72 max-w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        {error && <p role="alert" className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-lg bg-red-700 px-4 py-3 text-center text-sm text-white">{error}</p>}
        <div className="absolute right-2.5 top-2.5 flex items-center gap-2">
          {linterna != null && (
            <button
              type="button"
              aria-label={linterna ? 'Apagar linterna' : 'Encender linterna'}
              aria-pressed={linterna}
              title={linterna ? 'Apagar linterna' : 'Encender linterna'}
              onClick={alternarLinterna}
              className={`${iconoBtn} ${linterna ? 'bg-amber-400 text-gray-900' : 'bg-black/60 text-white backdrop-blur-sm'}`}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            aria-label={modoGatillo ? 'Volver a lectura continua' : 'Activar modo gatillo'}
            aria-pressed={modoGatillo}
            title={modoGatillo ? 'Lectura continua' : 'Modo gatillo'}
            onClick={() => setModoGatillo(m => !m)}
            className={`${iconoBtn} ${modoGatillo ? 'bg-white text-gray-900' : 'bg-black/60 text-white backdrop-blur-sm'}`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Cerrar cámara"
            title="Cerrar cámara"
            onClick={onCerrar}
            className={`${iconoBtn} bg-black/60 text-white backdrop-blur-sm`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {modoGatillo && (
          <button
            type="button"
            onClick={() => { gatillo.current = { activo: true, hasta: performance.now() + GATILLO_MS } }}
            className="absolute bottom-3 left-1/2 h-16 w-16 -translate-x-1/2 rounded-full border-4 border-white bg-white/30 text-xs font-bold text-white"
          >
            Leer
          </button>
        )}
      </div>
      {process.env.NODE_ENV !== 'production' && (
        <form
          onSubmit={e => {
            e.preventDefault()
            const i = e.currentTarget.elements.namedItem('raw') as HTMLInputElement
            if (i.value.trim()) simular.current?.(i.value.trim())
            i.select()
          }}
          className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5"
        >
          <input name="raw" autoComplete="off" placeholder="Prueba (dev): código o etiqueta (36DH0034-6-450)" aria-label="Simular una lectura"
            className="min-h-9 min-w-0 flex-1 rounded-md border border-dashed border-amber-400 bg-white px-2.5 font-mono text-xs" />
          <button className="min-h-9 rounded-md bg-amber-400 px-3 text-xs font-semibold text-gray-900">Leer</button>
        </form>
      )}
      {children && <div className="min-h-0 flex-1 overflow-y-auto bg-white p-3">{children}</div>}
      {pie && <div className="shrink-0 border-t border-gray-200 bg-white">{pie}</div>}
    </div>,
    document.body,
  )
}
