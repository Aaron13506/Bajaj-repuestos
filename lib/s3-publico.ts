// Dónde se leen las imágenes que subimos al bucket, y cómo se habla con él.
//
// La URL pública NO se deriva del endpoint: depende de quién aloja el bucket
// (Supabase la arma de una manera, S3/Lightsail de otra), y derivarla fue lo que dejó
// `supabase.co` escrito en la base. Se declara entera en `S3_PUBLIC_BASE_URL`, sin
// valor por defecto: si falta, el script se detiene en vez de inventar una.

/** Prefijo público de los objetos, sin barra final: `<base>/<key>` es la URL de una imagen. */
export function s3PublicBase(): string {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '')
  if (!base) throw new Error('Falta S3_PUBLIC_BASE_URL (p. ej. https://motokira-images.s3.us-east-1.amazonaws.com)')
  return base
}

/** `endpoint` solo existe en un S3 de terceros (Supabase); AWS/Lightsail usa el suyo y direccionamiento virtual. */
export function s3ClientConfig() {
  const endpoint = process.env.S3_ENDPOINT_URL?.trim() || undefined
  return {
    region: process.env.S3_REGION!,
    endpoint,
    forcePathStyle: !!endpoint,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  }
}
