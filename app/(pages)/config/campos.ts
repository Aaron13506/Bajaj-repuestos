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
  /** Lista cerrada de opciones: un select en vez de un campo libre. */
  options?: string[]
  /** La escribe el cron horario de fx:update — se muestra hace cuánto se guardó, para
   *  notar en la UI un cron caído en vez de arrastrar una tasa vieja sin que nada lo diga.
   *  Además `saveConfig` no la pisa si el cron escribió después de abrirse el formulario. */
  cron?: boolean
}

export const FIELD_META: Record<string, FieldMeta> = {
  inr_usd_rate:           { label: 'Tasa INR / USD',               hint: 'Rupias indias por 1 USD — ver XE.com', cron: true },
  bsd_usd_rate:           { label: 'Tasa BsD / USD',               hint: 'Bolívares por 1 USD, paralelo/Binance. Es la tasa a la que se cobra directo, sin recargo', cron: true },
  bcv_usd_rate:           { label: 'Tasa BCV / USD',                hint: 'Bolívares OFICIALES por 1 USD (usdt.com.ve)', cron: true },
  bcv_brecha_pct:         { label: 'Brecha BCV vs. paralelo (%)',   hint: 'Brecha del día entre el BCV y el mejor precio paralelo. El precio a tasa BCV la redondea hacia arriba en escalones de 5% antes de aplicarla', cron: true },
  shoppre_member:         { label: 'Membresía Shoppre',            hint: 'Tildado = tarifa de socio (el descuento que Shoppre aplica sobre el básico). Entra en el flete de todo lo que pasa por Shoppre: catálogo, presupuestos y envíos', boolean: true, booleanDefault: true },
  shoppre_carrier:        { label: 'Transportista Shoppre',        hint: 'Define la tabla escalón del tramo India → USA. Las opciones salen de la tarifa vigente' },
  reference_weight_kg:    { label: 'Peso de referencia (kg)',      hint: 'Peso total del envío de referencia para prorratear costos Shoppre' },
  air_volumetric_divisor: { label: 'Divisor volumétrico aéreo',     hint: 'vol_kg = L×A×H(cm) / divisor. Shoppre/ShipGlobal: 5000 (IATA clásico: 6000)' },
  miami_caracas_per_ft3:  { label: 'Marítimo Miami → CCS (USD/ft³)', hint: 'Costo del flete marítimo por pie cúbico' },
  shoppre_insurance_pct:  { label: 'Seguro Shoppre (fracción)',    hint: 'P.ej. 0.03 = 3% sobre el valor declarado' },
  shoppre_processing_inr: { label: 'Processing fee Shoppre (INR)', hint: 'Cargo fijo por paquete en rupias' },
  // ── Escenario marítimo directo (India → Venezuela por mar, sin aéreo ni escala en USA).
  // Solo lo usa el simulador (/simular, modo Marítimo). No afecta ningún costo actual.
  maritimo_directo_per_ft3: { label: 'Marítimo directo India → VEN (USD/ft³)', hint: 'Flete completo por mar, por pie cúbico. Reemplaza al aéreo + Miami→CCS. Vacío = usa la tarifa Miami→CCS como respaldo' },
  maritimo_min_ft3:         { label: 'Mínimo facturable marítimo (ft³)',       hint: 'Piso de volumen que cobra la naviera por embarque. 0 = cobra el volumen real, sin mínimo' },
  maritimo_fee_usd:         { label: 'Gastos fijos marítimo (USD)',            hint: 'Cargo fijo por caja: origen, destino, handling, aduana. 0 si ya están dentro del USD/ft³' },
  maritimo_insurance_pct:   { label: 'Seguro marítimo (fracción)',             hint: '% sobre el costo de producto. Vacío = 0.06 (6%), la prima por mar' },
  // ── Modo Marítimo CBM (India → Venezuela por mar, cotización real por m³).
  // Rigen el carril marítimo de mercancía propia (cajas `maritimo_cbm`) y la columna
  // marítima del catálogo. No hay modo global que activar: la ruta es de cada envío.
  cbm_rate_usd:           { label: 'Tarifa marítima (USD por m³)',   hint: 'Tarifa plana India → Venezuela por metro cúbico. Incluye todo el trayecto: flete, seguro, origen, destino y aduana' },
  cbm_fob_india_usd:      { label: 'FOB India (USD por embarque)',   hint: 'Monto FIJO por embarque, no escala con el volumen. Llenar más la caja lo diluye entre más piezas y baja el landed de cada una' },
  cbm_min_m3:             { label: 'Mínimo facturable (m³)',         hint: 'Piso de volumen que cobra la naviera por embarque aunque mandes menos. Vacío = 1 m³ (típico LCL)' },
  cbm_referencia_m3:      { label: 'Embarque de referencia (m³)',    hint: 'Volumen supuesto para prorratear el FOB al costear una pieza suelta en el catálogo. Vacío = 1 m³. Subilo si consolidás embarques más grandes: baja el landed de todo el catálogo' },
  default_margin_pct:     { label: 'Margen por defecto (%)',       hint: 'Margen de ganancia al crear un producto; luego se ajusta por producto' },
  terminos_presupuesto:   { label: 'Términos y condiciones — Presupuesto', hint: 'Texto que aparece al pie del presupuesto al imprimir / guardar como PDF', multiline: true },
  terminos_pedido:        { label: 'Términos y condiciones — Pedido oficial', hint: 'Texto que aparece al pie del pedido confirmado al imprimir / guardar como PDF', multiline: true },
}

/** Nombre del campo oculto con el que el formulario dice "así estaba la base cuando me abriste". */
export const CAMPO_CARGADO = '__cargado'
