// Peso y medidas del bulto al marcar la llegada (opcionales; lib/cajas-envio.ts bultoDeLlegada).
// Sin 'use client': son inputs sueltos dentro del form de la llegada, en la laptop y el teléfono.
export default function CamposBulto({ grande = false }: { grande?: boolean }) {
  const input = `rounded-lg border border-gray-300 px-2 text-right font-mono ${grande ? 'min-h-11 w-20 text-base' : 'min-h-9 w-16 text-sm'}`
  return (
    <fieldset className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <legend className="sr-only">Peso y medidas del bulto (opcional)</legend>
      {([['bultoPeso', 'kg'], ['bultoLargo', 'L cm'], ['bultoAncho', 'A cm'], ['bultoAlto', 'H cm']] as const).map(([name, label]) => (
        <label key={name} className="flex items-center gap-1">
          {label}
          <input name={name} inputMode="decimal" autoComplete="off" className={input} />
        </label>
      ))}
    </fieldset>
  )
}
