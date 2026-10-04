'use client'

// Red de seguridad de TODAS las páginas del grupo. Sin esto, una excepción en un Server
// Component o en una acción cae a la página de error genérica de Next, que ni siquiera deja
// seguir trabajando: hay que volver a escribir la URL.
//
// Ojo con lo que NO hace: en producción Next oculta el mensaje de los errores lanzados en el
// server ("An error occurred in the Server Components render…") y solo deja un `digest`. Por
// eso las reglas de negocio que el usuario tiene que leer se DEVUELVEN como `ActionResult` en
// vez de tirarse (ver lib/action-result.ts); esta pantalla es para lo inesperado, y el digest
// es lo que sirve para encontrar el error en los logs de Heroku.
export default function ErrorDePagina({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="max-w-xl mx-auto mt-16 bg-white rounded-xl border border-red-200 p-6 space-y-3">
      <h1 className="text-lg font-semibold text-gray-900">Algo salió mal</h1>
      <p className="text-sm text-gray-600">
        Esta pantalla no se pudo cargar o la acción no se completó. Antes de repetir una carga de
        plata, fijate si ya quedó registrada. Si sigue pasando, avisá con este código.
      </p>
      {error.digest && (
        <p className="text-xs font-mono text-gray-400 select-all">código: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        Reintentar
      </button>
    </div>
  )
}
