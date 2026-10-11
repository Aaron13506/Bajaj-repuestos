/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Una foto pegada en el formulario de producto viaja en el cuerpo de una server action
    // (components/PegarImagen.tsx). El navegador ya la achica antes de mandarla; esto es el
    // margen para la que igual sale grande. El default de 1 MB la rechazaba.
    serverActions: { bodySizeLimit: '6mb' },
  },
}

export default nextConfig
