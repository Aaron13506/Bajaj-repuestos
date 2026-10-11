'use server'

import { ErrorDeNegocio } from '@/lib/action-result'
import { copiarImagenAlBucket, subirImagen } from '@/lib/imagen-producto'

// La foto pegada en el formulario de producto (components/PegarImagen.tsx) se sube EN EL
// MOMENTO de pegarla, no al guardar: así la vista previa ya es la imagen de nuestro bucket y,
// si algo falla, se ve ahí mismo y no al final con el formulario lleno. Si después no se
// guarda el producto queda un objeto suelto en el bucket — barato, y como la key es el hash
// del contenido, pegar la misma foto otra vez no lo duplica.

export type ResultadoImagen = { ok: true; url: string } | { ok: false; error: string }

async function conMotivo(subir: () => Promise<string>): Promise<ResultadoImagen> {
  try {
    return { ok: true, url: await subir() }
  } catch (e) {
    if (e instanceof ErrorDeNegocio) return { ok: false, error: e.message }
    throw e
  }
}

/** Los bytes de la imagen que estaba en el portapapeles (campo `imagen`). */
export async function subirImagenPegada(formData: FormData): Promise<ResultadoImagen> {
  const archivo = formData.get('imagen')
  if (!(archivo instanceof File)) return { ok: false, error: 'No llegó ninguna imagen.' }
  return conMotivo(async () => subirImagen(Buffer.from(await archivo.arrayBuffer()), archivo.type))
}

/** Lo pegado era solo la dirección de la imagen: se baja y se copia al bucket. */
export async function copiarImagenPegada(url: string): Promise<ResultadoImagen> {
  return conMotivo(() => copiarImagenAlBucket(url))
}
