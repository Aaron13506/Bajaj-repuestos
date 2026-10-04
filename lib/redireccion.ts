// Una server action que termina en `redirect()` NO resuelve su promesa en el cliente: Next la
// RECHAZA con un error NEXT_REDIRECT (server-action-reducer.js) mientras la navegación ya está
// en curso. Un `try/catch` que trate cualquier rechazo como una falla muestra entonces un error
// falso justo después de un éxito — «No se pudo completar la acción» al borrar un presupuesto
// que sí se borró — y, en un formulario, vuelve a habilitar el botón en pleno redireccionamiento.
//
// Se reconoce por el `digest` y no importando el helper interno de Next (`isRedirectError`), que
// vive en una ruta no pública y ya cambió de lugar entre versiones.
export function esRedireccion(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null)?.digest
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')
}
