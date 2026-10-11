// ─────────────────────────────────────────────────────────────────────────────
// Copiar la foto de un producto a nuestro bucket.
//
// Las fotos de los productos que no vienen de un catálogo salen de internet: se copian en la
// web y se PEGAN en el formulario (components/PegarImagen.tsx). Lo que llega es la imagen
// misma, o —si el navegador solo copió la dirección— su URL. Guardar una URL ajena deja la
// foto en manos de otro: la publicación cambia, el sitio rota el archivo, y la pieza queda
// sin imagen en presupuestos y PDFs sin que nada avise. Así que todo termina en
// `motokira-images`, que es donde ya viven las de 99rpm.
//
// La key es el hash del contenido: la misma foto pegada dos veces es un solo objeto, y un
// reintento después de un fallo no deja basura. Va bajo `productos/` para no mezclarse con
// las de los ensambles, que están en la raíz.
//
// Solo server (credenciales del bucket). Si algo falla se lanza ErrorDeNegocio con el
// motivo: el formulario lo muestra y no se guarda — guardar sin foto en silencio, o con
// la URL ajena, es justo lo que esto evita.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { ErrorDeNegocio } from '@/lib/action-result'
import { s3ClientConfig, s3PublicBase } from '@/lib/s3-publico'

const MAX_BYTES = 10 * 1024 * 1024

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/**
 * La foto grande de Amazon. Sus URLs de producto llevan los modificadores de tamaño antes
 * de la extensión (`…/71abc._AC_SX300_SY300_QL70_.jpg`) y sin ellos sirven el original.
 * Solo /images/I/: los recursos del sitio usan el mismo patrón como versión de caché
 * (`._CB5468_.png`) y sin él no existen. Otras URLs pasan tal cual.
 */
export function imagenGrande(url: string): string {
  let u: URL
  try { u = new URL(url) } catch { return url }
  if (!/(^|\.)media-amazon\.com$/i.test(u.hostname) || !u.pathname.startsWith('/images/I/')) return url
  return url.replace(/\._[^/]*_\.(jpe?g|png|webp|gif)(\?.*)?$/i, '.$1')
}

/** La URL ya es de nuestro bucket: no hay nada que copiar. */
export function esImagenPropia(url: string): boolean {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '')
  return !!base && url.startsWith(`${base}/`)
}

/**
 * Devuelve la URL pública en nuestro bucket de la imagen que está en `url`. Si ya es
 * nuestra la devuelve igual. Lanza ErrorDeNegocio si no se puede bajar o subir.
 */
export async function copiarImagenAlBucket(url: string): Promise<string> {
  if (esImagenPropia(url)) return url

  let u: URL
  try { u = new URL(imagenGrande(url.trim())) } catch { throw new ErrorDeNegocio('La URL de la foto no es válida.') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ErrorDeNegocio('La URL de la foto tiene que empezar con https://.')

  let res: Response
  try {
    res = await fetch(u, {
      signal: AbortSignal.timeout(20_000),
      // Algunos CDNs (Amazon entre ellos) responden distinto sin un User-Agent de navegador.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'image/*' },
    })
  } catch {
    throw new ErrorDeNegocio(`No pude descargar la foto (${u.hostname} no respondió). Probá de nuevo o usá otra URL.`)
  }
  if (!res.ok) throw new ErrorDeNegocio(`No pude descargar la foto: ${u.hostname} respondió ${res.status}.`)

  const tipo = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (tipo.startsWith('text/html')) {
    throw new ErrorDeNegocio('Esa dirección es una página, no una imagen. En la foto: clic derecho → "Copiar imagen", y pegala.')
  }
  return subirImagen(Buffer.from(await res.arrayBuffer()), tipo)
}

/**
 * Sube los bytes de una imagen (la pegada desde el portapapeles, o la bajada de una URL) y
 * devuelve su URL pública. Lanza ErrorDeNegocio si no es una imagen usable o falla la subida.
 */
export async function subirImagen(body: Buffer, tipoCrudo: string): Promise<string> {
  const tipo = tipoCrudo.split(';')[0].trim().toLowerCase()
  const ext = EXTENSION[tipo]
  if (!ext) throw new ErrorDeNegocio(`Eso no es una imagen que se pueda usar (${tipo || 'sin tipo'}).`)
  if (body.length === 0) throw new ErrorDeNegocio('La imagen está vacía.')
  if (body.length > MAX_BYTES) throw new ErrorDeNegocio(`La imagen pesa ${(body.length / 1024 / 1024).toFixed(1)} MB; el máximo es 10 MB.`)

  const bucket = process.env.S3_BUCKET_NAME?.trim()
  let base: string
  try { base = s3PublicBase() } catch { base = '' }
  if (!bucket || !base) throw new ErrorDeNegocio('Falta configurar el bucket de imágenes (S3_BUCKET_NAME / S3_PUBLIC_BASE_URL) en el servidor.')

  const key = `productos/${createHash('sha256').update(body).digest('hex').slice(0, 24)}.${ext}`
  const s3 = new S3Client(s3ClientConfig())
  try {
    const existe = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, () => false)
    if (!existe) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: tipo,
        // El contenido de una key nunca cambia (es su hash): se puede cachear para siempre.
        CacheControl: 'public, max-age=31536000, immutable',
      }))
    }
  } catch (e) {
    console.error('[imagen-producto] subida a S3', e)
    throw new ErrorDeNegocio('No pude subir la foto al bucket. Probá de nuevo.')
  } finally {
    s3.destroy()
  }
  return `${base}/${key}`
}
