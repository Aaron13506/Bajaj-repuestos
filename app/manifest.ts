import type { MetadataRoute } from 'next'

// La app instalable del teléfono: abre directo en /escanear, a pantalla completa. El navegador
// pide este archivo y los íconos SIN cookies, por eso proxy.ts y oauth2-proxy los dejan pasar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Motokira',
    short_name: 'Motokira',
    start_url: '/escanear',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#111827',
    theme_color: '#111827',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
