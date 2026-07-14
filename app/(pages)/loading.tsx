// Fallback de carga para TODAS las páginas del grupo. Con esto el App Router
// cambia la URL al instante y muestra este esqueleto mientras el Server Component
// consulta la DB remota, en vez de quedarse "congelado" esperando la respuesta.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-64 bg-gray-200 rounded-lg" />
      <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
        <div className="h-4 w-1/3 bg-gray-100 rounded" />
        <div className="h-4 w-1/2 bg-gray-100 rounded" />
        <div className="h-4 w-2/5 bg-gray-100 rounded" />
      </div>
      <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-5 bg-gray-100 rounded" style={{ width: `${90 - i * 8}%` }} />
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className="inline-block w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
        Cargando…
      </div>
    </div>
  )
}
