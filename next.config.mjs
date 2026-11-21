// Probar con el teléfono contra `pnpm dev` (cámara = HTTPS): `tailscale serve --bg 3123` publica
// la PC solo dentro de la tailnet. Solo en dev: en producción el origen sigue siendo el propio.
const pcEnTailnet = process.env.NODE_ENV === 'development' ? ['desktop-rjp8a0i.tailb33395.ts.net'] : []

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: pcEnTailnet,
  experimental: {
    // Una foto pegada en el formulario de producto viaja en el cuerpo de una server action
    // (components/PegarImagen.tsx). El navegador ya la achica antes de mandarla; esto es el
    // margen para la que igual sale grande. El default de 1 MB la rechazaba.
    serverActions: { bodySizeLimit: '6mb', allowedOrigins: pcEnTailnet },
  },
}

export default nextConfig
