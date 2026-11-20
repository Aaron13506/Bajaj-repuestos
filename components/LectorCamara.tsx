'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BarcodeDetector as Detector } from 'barcode-detector/ponyfill'
import type { Senal } from './senal'

const FORMATOS = ['qr_code', 'code_128'] as const
// La misma etiqueta vuelve a contar cuando dejó de verse este tiempo: el hueco natural al
// cambiar una caja por la siguiente (diez filtros iguales seguidos). Se ajusta en el depósito.
const REARME_MS = 300
// En modo gatillo, cuánto espera una etiqueta después de tocar el botón.
const GATILLO_MS = 1500

// Cámara del teléfono a pantalla completa leyendo QR (cajas de Bajaj) y Code 128 (bolsas del
// proveedor). Cada lectura nueva llama a `onLectura`, que devuelve cómo le fue para el destello
// del borde (puede ser una promesa: Consultar espera al servidor para saber si la encontró).
// `children` se muestra abajo (el aviso de la última lectura, con sus botones).
export default function LectorCamara({
  onLectura,
  onCerrar,
  children,
}: {
  onLectura: (raw: string) => Senal | Promise<Senal>
  onCerrar: () => void
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

  useEffect(() => {
    let vivo = true
    let stream: MediaStream | null = null
    let raf = 0
    let apagarFlash = 0
    const vistos = new Map<string, number>() // raw → última vez que se vio
    const emitir = async (raw: string) => {
      let r: Senal
      try { r = await cb.current(raw) } catch { r = 'error' }
      if (!vivo) return
      setFlash(r)
      clearTimeout(apagarFlash)
      apagarFlash = window.setTimeout(() => setFlash(null), 250)
    }
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        if (!vivo) return
        const v = video.current!
        v.srcObject = stream
        await v.play()
        track.current = stream.getVideoTracks()[0]
        const caps = track.current.getCapabilities?.() as { torch?: boolean } | undefined
        setLinterna(caps?.torch ? false : null)

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
              if (!g.activo && !modoGatilloRef.current && (antes == null || ahora - antes > REARME_MS)) void emitir(raw)
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

  const borde = flash === 'ok' ? 'border-green-500' : flash === 'bolsa' ? 'border-amber-400' : flash === 'error' ? 'border-red-600' : 'border-transparent'

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Escanear con la cámara" className={`fixed inset-0 z-50 flex flex-col bg-black border-8 ${borde}`}>
      {/* overflow-hidden: la sombra del recuadro (9999px) no debe oscurecer el panel de abajo */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video ref={video} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
        <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-56 w-72 max-w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        {error && <p role="alert" className="absolute inset-x-4 top-1/3 rounded-lg bg-red-700 px-4 py-3 text-center text-white">{error}</p>}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-3">
          <button type="button" onClick={onCerrar} className="min-h-11 rounded-lg bg-white/90 px-4 text-sm font-semibold text-gray-900">
            Cerrar
          </button>
          <div className="flex gap-2">
            {linterna != null && (
              <button type="button" aria-pressed={linterna} onClick={alternarLinterna} className="min-h-11 rounded-lg bg-white/90 px-4 text-sm font-semibold text-gray-900">
                Linterna
              </button>
            )}
            <button type="button" aria-pressed={modoGatillo} onClick={() => setModoGatillo(m => !m)} className="min-h-11 rounded-lg bg-white/90 px-4 text-sm font-semibold text-gray-900">
              {modoGatillo ? 'Lectura continua' : 'Modo gatillo'}
            </button>
          </div>
        </div>
        {modoGatillo && (
          <button
            type="button"
            onClick={() => { gatillo.current = { activo: true, hasta: performance.now() + GATILLO_MS } }}
            className="absolute bottom-4 left-1/2 h-20 w-20 -translate-x-1/2 rounded-full border-4 border-white bg-white/30 text-sm font-bold text-white"
          >
            Leer
          </button>
        )}
      </div>
      {children && <div className="max-h-[55dvh] overflow-y-auto bg-white p-3">{children}</div>}
    </div>,
    document.body,
  )
}
