// En qué base están el peso y las medidas (Product.medidaBase, lib/medido.ts): siempre UNA pieza,
// con su caja si viene en caja, suelta si viene de a varias en bolsa. Edición completa y rápida.
export default function CamposBaseMedida({ base, labelClass, inputClass }: {
  base: string | null | undefined
  labelClass: string
  inputClass: string
}) {
  return (
    <label className="block">
      <span className={labelClass}>Base de la medida</span>
      <select name="medidaBase" defaultValue={base ?? ''} className={inputClass}>
        <option value="">Sin saber (re-medir)</option>
        <option value="empaque">En caja: medida con su caja</option>
        <option value="pieza">De bolsa: una pieza suelta</option>
      </select>
    </label>
  )
}
