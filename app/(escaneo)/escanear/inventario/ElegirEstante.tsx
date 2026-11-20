'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { leerEtiqueta } from '@/lib/qr-bajaj'
import { esRedireccion } from '@/lib/redireccion'
import { senal, type Senal } from '@/components/senal'
import { abrirEstante } from './actions'

const LectorCamara = dynamic(() => import('@/components/LectorCamara'), { ssr: false })

// Escaneá la etiqueta del estante (UBI:A-3) o escribilo: abre su conteo (o el que ya estaba abierto).
export default function ElegirEstante() {
  const [camara, setCamara] = useState(false)
  const [texto, setTexto] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function abrir(estante: string): Promise<Senal> {
    setError(null)
    const fd = new FormData()
    fd.set('estante', estante)
    try {
      const r = await abrirEstante(fd)
      if (r && !r.ok) { setError(r.error); senal('error'); return 'error' }
    } catch (e) {
      // Abrió y ya está navegando al conteo (ver lib/redireccion.ts).
      if (esRedireccion(e)) { senal('ok'); return 'ok' }
      setError('No se pudo abrir: revisá la señal y reintentá.')
      senal('error')
      return 'error'
    }
    senal('ok')
    return 'ok'
  }

  function leer(raw: string): Senal | Promise<Senal> {
    if (leerEtiqueta(raw).tipo !== 'ubicacion') {
      senal('error')
      setError('Eso es una pieza: escaneá primero la etiqueta del estante (UBI:…).')
      return 'error'
    }
    return abrir(raw)
  }

  const panel = (
    <div className="space-y-2">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (texto.trim()) void abrir(texto) }}>
        <input
          value={texto}
          onChange={e => setTexto(e.target.value)}
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="characters"
          aria-label="Estante"
          placeholder="Estante, por ejemplo A-3"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 font-mono text-base"
        />
        <button className="min-h-11 rounded-lg bg-blue-600 px-4 font-semibold text-white">Contar</button>
        {!camara && <button type="button" onClick={() => setCamara(true)} className="min-h-11 rounded-lg bg-gray-900 px-4 font-semibold text-white">Cámara</button>}
      </form>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 font-medium text-red-800">{error}</p>}
    </div>
  )

  return camara ? <LectorCamara onLectura={leer} onCerrar={() => setCamara(false)}>{panel}</LectorCamara> : panel
}
