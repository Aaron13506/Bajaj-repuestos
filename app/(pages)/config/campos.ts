import { parsearTablaPorKilo } from '@/lib/reenvio'

// Los campos de /config que el código conoce. Vive aparte de la página porque lo comparten
// dos: la página, que lo pinta, y `saveConfig`, que lo usa para decidir qué claves acepta
// y cuáles escribe el cron (un módulo `page.tsx` no puede exportar nada más que la página).

export type FieldMeta = {
  label: string
  hint: string
  multiline?: boolean
  /** Sí/no: se edita con un check, no escribiendo la palabra "true". */
  boolean?: boolean
  /** Valor de la bandera cuando la key falta o está vacía. Tiene que ser el mismo que
   *  usa quien la lee (ver `flag` en lib/config.ts), o el check miente sobre lo que cobra. */
  booleanDefault?: boolean
  /** Texto al lado del check: qué hace tildarlo. */
  checkLabel?: string
  /** Lista cerrada de opciones: un select en vez de un campo libre. */
  options?: string[]
  /** La escribe el cron horario de fx:update — se muestra hace cuánto se guardó, para
   *  notar en la UI un cron caído en vez de arrastrar una tasa vieja sin que nada lo diga.
   *  Además `saveConfig` no la pisa si el cron escribió después de abrirse el formulario. */
  cron?: boolean
  /** Texto con formato propio: `saveConfig` rechaza lo que no lee (vacío sí entra). */
  valido?: (v: string) => boolean
  /** Rango aceptado [mín, máx] para un número. `saveConfig` rechaza lo de afuera: `num()` lee
   *  cualquier texto con parseFloat, así que "3" en un seguro que va en fracción era un 300%. */
  rango?: [number, number]
}

const POSITIVO: [number, number] = [0.0001, Infinity]
const NO_NEGATIVO: [number, number] = [0, Infinity]
// Los seguros van en FRACCIÓN (0.03 = 3%) aunque la clave diga `_pct`, a diferencia del margen y
// la brecha, que van en porcentaje. El techo de 0.5 es lo que delata un "3" escrito como 3%.
const FRACCION: [number, number] = [0, 0.5]

export const FIELD_META: Record<string, FieldMeta> = {
  inr_usd_rate:           { label: 'Tasa INR / USD',               hint: 'Rupias indias por 1 USD.', cron: true, rango: POSITIVO },
  bsd_usd_rate:           { label: 'Tasa BsD / USD',               hint: 'Bs por 1 USD (paralelo/Binance). Tasa de cobro directo.', cron: true, rango: POSITIVO },
  bcv_usd_rate:           { label: 'Tasa BCV / USD',                hint: 'Bs oficiales por 1 USD (BCV).', cron: true, rango: POSITIVO },
  bcv_brecha_pct:         { label: 'Brecha BCV vs. paralelo (%)',   hint: 'Paralelo sobre BCV (%). Define el escalón de descuento en divisas.', cron: true, rango: [0, 95] },
  shoppre_member:         { label: 'Membresía Shoppre',            hint: 'Aplica tarifa de socio Shoppre en catálogo, presupuestos y envíos.', boolean: true, booleanDefault: true, checkLabel: 'Aplicar la tarifa de socio' },
  shoppre_carrier:        { label: 'Transportista Shoppre',        hint: 'Tabla escalón India → USA de la tarifa Shoppre vigente.' },
  reference_weight_kg:    { label: 'Peso de referencia (kg)',      hint: 'Peso de referencia (kg) para prorratear costos Shoppre.', rango: POSITIVO },
  air_volumetric_divisor: { label: 'Divisor volumétrico aéreo',     hint: 'vol_kg = L×A×H(cm) / divisor. Shoppre: 5000 (IATA: 6000).', rango: POSITIVO },
  miami_caracas_per_ft3:  { label: 'Marítimo Miami → CCS (USD/ft³)', hint: 'Flete marítimo Miami → Caracas por pie cúbico (USD).', rango: NO_NEGATIVO },
  caja_sin_pesar_tolerancia_pct: { label: 'Tolerancia de una caja sin pesar (%)', hint: 'Margen (%) para repartir gradualmente entre peso y volumen si la caja no está pesada. Default: 10.', rango: [0, 100] },
  shoppre_insurance_pct:  { label: 'Seguro Shoppre (fracción)',    hint: 'Fracción sobre valor declarado (0.03 = 3%).', rango: FRACCION },
  shoppre_processing_inr: { label: 'Processing fee Shoppre (INR)', hint: 'Cargo fijo por paquete en rupias.', rango: NO_NEGATIVO },
  // El otro reenvío India → USA, en paralelo a Shoppre (lib/reenvio.ts): su tabla por peso de caja.
  reenvio_kilo_tarifa_inr: { label: 'Reenvío por kilo: tabla (₹)', hint: 'JSON de tramos [{"hastaKg", "inr", "total"}] o número plano ₹/kg. Vacío = oculta ruta por kilo.', multiline: true, valido: v => parsearTablaPorKilo(v) != null },
  reenvio_precios:         { label: 'Reenvío con el que se cotiza', hint: 'Reenvío por defecto al crear presupuestos por Miami.', options: ['shoppre', 'por_kilo'] },
  reenvio_kilo_en_catalogo: { label: 'Ruta por kilo en el catálogo', hint: 'Muestra bloque por kilo en catálogo (requiere tarifa cargada).', boolean: true, booleanDefault: true, checkLabel: 'Mostrar la ruta por kilo en el catálogo' },
  // ── Envío express (Shoppre directo India → Venezuela). La tarifa la trae el cron
  // (shoppre_rates_ve_usd); seguro, processing y socio son los mismos de Shoppre.
  express_tope_usd:   { label: 'Tope del paquete express (USD)', hint: 'Landed máximo por paquete express directo. Vacío = 100.', rango: POSITIVO },
  express_plazo_dias: { label: 'Plazo express (días hábiles)',  hint: 'Plazo mostrado en el PDF. Vacío = 10 a 15.' },
  oneway_aereo_usd_lb:      { label: 'One Way aéreo Miami → CCS (USD/lb)', hint: 'Express por USA: tarifa por libra cobrable. Vacío = 5.', rango: NO_NEGATIVO },
  oneway_aereo_paquete_usd: { label: 'One Way aéreo: recibir el paquete (USD)', hint: 'Express por USA: cargo fijo por paquete en Miami. Vacío = 1.', rango: NO_NEGATIVO },
  express_margen_pct: { label: 'Margen express (%)',             hint: 'Margen sobre landed express. Vacío = margen por defecto.', rango: [0, 95] },
  // ── Escenario marítimo directo (India → Venezuela por mar, sin aéreo ni escala en USA).
  // Solo lo usa el simulador (/simular, modo Marítimo). No afecta ningún costo actual.
  maritimo_directo_per_ft3: { label: 'Marítimo directo India → VEN (USD/ft³)', hint: 'Flete marítimo directo por ft³ (/simular). Vacío = usa Miami→CCS.', rango: NO_NEGATIVO },
  maritimo_min_ft3:         { label: 'Mínimo facturable marítimo (ft³)',       hint: 'Volumen mínimo facturable en ft³. 0 = sin mínimo.', rango: NO_NEGATIVO },
  maritimo_fee_usd:         { label: 'Gastos fijos marítimo (USD)',            hint: 'Cargo fijo por caja en USD (0 si va incluido en USD/ft³).', rango: NO_NEGATIVO },
  maritimo_insurance_pct:   { label: 'Seguro marítimo (fracción)',             hint: 'Fracción sobre valor de producto. Vacío = 0.06 (6%).', rango: FRACCION },
  // ── Modo Marítimo CBM (India → Venezuela por mar, cotización real por m³).
  // Rigen el carril marítimo de mercancía propia (cajas `maritimo_cbm`) y la columna
  // marítima del catálogo. No hay modo global que activar: la ruta es de cada envío.
  cbm_rate_usd:           { label: 'Tarifa marítima (USD por m³)',   hint: 'Tarifa plana India → Venezuela por m³ (todo incluido).', rango: NO_NEGATIVO },
  cbm_fob_india_usd:      { label: 'FOB India (USD por embarque)',   hint: 'Monto fijo por embarque marítimo.', rango: NO_NEGATIVO },
  cbm_min_m3:             { label: 'Mínimo facturable (m³)',         hint: 'Volumen mínimo facturable por embarque. Vacío = 1 m³.', rango: NO_NEGATIVO },
  cbm_referencia_m3:      { label: 'Embarque de referencia (m³)',    hint: 'Volumen supuesto para prorratear FOB en catálogo. Vacío = 1 m³.', rango: NO_NEGATIVO },
  // Solo pantalla: no toca ningún costo. Las columnas marítimas en la tabla de componentes de
  // un ensamble ensanchan la tabla y todavía no se usan; apagadas por defecto.
  ensambles_columnas_maritimas: { label: 'Columnas marítimas en ensambles', hint: 'Muestra columnas marítimas (🚢) en la ficha de ensambles.', boolean: true, booleanDefault: false, checkLabel: 'Mostrar las columnas 🚢 en la ficha del ensamble' },
  default_margin_pct:     { label: 'Margen por defecto (%)',       hint: 'Margen inicial al crear productos.', rango: [0, 95] },
  presupuesto_validez_dias: { label: 'Validez del presupuesto (días)', hint: 'Vigencia del presupuesto en días. Vacío = 7 (actualizar en términos si cambia).', rango: [1, 365] },
  reclamo_horas:          { label: 'Plazo para reclamar (horas)', hint: 'Horas desde la entrega para reclamos en plazo. Vacío = 48.', rango: [1, 10000] },
  terminos_presupuesto:   { label: 'Términos y condiciones — Presupuesto', hint: 'Pie de página del PDF de presupuesto.', multiline: true },
  terminos_pedido:        { label: 'Términos y condiciones — Pedido oficial', hint: 'Pie de página del PDF de pedido confirmado.', multiline: true },
}

/** Nombre del campo oculto con el que el formulario dice "así estaba la base cuando me abriste". */
export const CAMPO_CARGADO = '__cargado'
