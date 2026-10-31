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
  inr_usd_rate:           { label: 'Tasa INR / USD',               hint: 'Rupias indias por 1 USD — ver XE.com', cron: true, rango: POSITIVO },
  bsd_usd_rate:           { label: 'Tasa BsD / USD',               hint: 'Bolívares por 1 USD, paralelo/Binance. Es la tasa a la que se cobra directo, sin recargo', cron: true, rango: POSITIVO },
  bcv_usd_rate:           { label: 'Tasa BCV / USD',                hint: 'Bolívares OFICIALES por 1 USD (usdt.com.ve)', cron: true, rango: POSITIVO },
  bcv_brecha_pct:         { label: 'Brecha BCV vs. paralelo (%)',   hint: 'Brecha del día del mejor precio paralelo sobre el BCV (paralelo / BCV − 1). El precio a tasa BCV la pasa a descuento (brecha / (1 + brecha): 40% de brecha es 28.6% de descuento) y la redondea hacia arriba en escalones de 5%: ese es el descuento por pago en divisas', cron: true, rango: [0, 95] },
  shoppre_member:         { label: 'Membresía Shoppre',            hint: 'Tildado = tarifa de socio (el descuento que Shoppre aplica sobre el básico). Entra en el flete de todo lo que pasa por Shoppre: catálogo, presupuestos y envíos', boolean: true, booleanDefault: true, checkLabel: 'Aplicar la tarifa de socio' },
  shoppre_carrier:        { label: 'Transportista Shoppre',        hint: 'Define la tabla escalón del tramo India → USA. Las opciones salen de la tarifa vigente' },
  reference_weight_kg:    { label: 'Peso de referencia (kg)',      hint: 'Peso total del envío de referencia para prorratear costos Shoppre', rango: POSITIVO },
  air_volumetric_divisor: { label: 'Divisor volumétrico aéreo',     hint: 'vol_kg = L×A×H(cm) / divisor. Shoppre/ShipGlobal: 5000 (IATA clásico: 6000)', rango: POSITIVO },
  miami_caracas_per_ft3:  { label: 'Marítimo Miami → CCS (USD/ft³)', hint: 'Costo del flete marítimo por pie cúbico', rango: NO_NEGATIVO },
  caja_sin_pesar_tolerancia_pct: { label: 'Tolerancia de una caja sin pesar (%)', hint: 'En una caja que todavía no se pesó y midió, "ata el volumen" sale de comparar dos sumas de piezas. Si el volumétrico supera al real por menos de este %, el flete aéreo se reparte entre pedidos de forma gradual (peso → volumen) y no todo por volumen. Con la caja pesada y medida no aplica. Default 10', rango: [0, 100] },
  shoppre_insurance_pct:  { label: 'Seguro Shoppre (fracción)',    hint: 'P.ej. 0.03 = 3% sobre el valor declarado', rango: FRACCION },
  shoppre_processing_inr: { label: 'Processing fee Shoppre (INR)', hint: 'Cargo fijo por paquete en rupias', rango: NO_NEGATIVO },
  reenvio_kilo_gastos_inr: { label: 'Gastos fijos reenvío por kilo (INR)', hint: 'Repack y demás cargos fijos por caja de las cajas que van por el reenvío por kilo. El ₹/kg se carga en cada caja. Vacío = sin configurar (la caja lo avisa). La factura real los reemplaza', rango: NO_NEGATIVO },
  // ── Envío express (Shoppre directo India → Venezuela). La tarifa la trae el cron
  // (shoppre_rates_ve_usd); seguro, processing y socio son los mismos de Shoppre.
  express_tope_usd:   { label: 'Tope del paquete express (USD)', hint: 'El landed de cada paquete express (producto + flete + seguro + processing) no puede pasar de este monto. Vacío = 100', rango: POSITIVO },
  express_plazo_dias: { label: 'Plazo express (días hábiles)',  hint: 'Lo que se le promete al cliente en el PDF, contado desde la compra. Ej: "10 a 13". Vacío = 10 a 13' },
  express_margen_pct: { label: 'Margen express (%)',             hint: 'Margen sobre el landed del paquete express. Vacío = el margen por defecto', rango: [0, 95] },
  // ── Escenario marítimo directo (India → Venezuela por mar, sin aéreo ni escala en USA).
  // Solo lo usa el simulador (/simular, modo Marítimo). No afecta ningún costo actual.
  maritimo_directo_per_ft3: { label: 'Marítimo directo India → VEN (USD/ft³)', hint: 'Flete completo por mar, por pie cúbico. Reemplaza al aéreo + Miami→CCS. Vacío = usa la tarifa Miami→CCS como respaldo', rango: NO_NEGATIVO },
  maritimo_min_ft3:         { label: 'Mínimo facturable marítimo (ft³)',       hint: 'Piso de volumen que cobra la naviera por embarque. 0 = cobra el volumen real, sin mínimo', rango: NO_NEGATIVO },
  maritimo_fee_usd:         { label: 'Gastos fijos marítimo (USD)',            hint: 'Cargo fijo por caja: origen, destino, handling, aduana. 0 si ya están dentro del USD/ft³', rango: NO_NEGATIVO },
  maritimo_insurance_pct:   { label: 'Seguro marítimo (fracción)',             hint: '% sobre el costo de producto. Vacío = 0.06 (6%), la prima por mar', rango: FRACCION },
  // ── Modo Marítimo CBM (India → Venezuela por mar, cotización real por m³).
  // Rigen el carril marítimo de mercancía propia (cajas `maritimo_cbm`) y la columna
  // marítima del catálogo. No hay modo global que activar: la ruta es de cada envío.
  cbm_rate_usd:           { label: 'Tarifa marítima (USD por m³)',   hint: 'Tarifa plana India → Venezuela por metro cúbico. Incluye todo el trayecto: flete, seguro, origen, destino y aduana', rango: NO_NEGATIVO },
  cbm_fob_india_usd:      { label: 'FOB India (USD por embarque)',   hint: 'Monto FIJO por embarque, no escala con el volumen. Llenar más la caja lo diluye entre más piezas y baja el landed de cada una', rango: NO_NEGATIVO },
  cbm_min_m3:             { label: 'Mínimo facturable (m³)',         hint: 'Piso de volumen que cobra la naviera por embarque aunque mandes menos. Vacío = 1 m³ (típico LCL)', rango: NO_NEGATIVO },
  cbm_referencia_m3:      { label: 'Embarque de referencia (m³)',    hint: 'Volumen supuesto para prorratear el FOB al costear una pieza suelta en el catálogo. Vacío = 1 m³. Subilo si consolidás embarques más grandes: baja el landed de todo el catálogo', rango: NO_NEGATIVO },
  // Solo pantalla: no toca ningún costo. Las columnas marítimas en la tabla de componentes de
  // un ensamble ensanchan la tabla y todavía no se usan; apagadas por defecto.
  ensambles_columnas_maritimas: { label: 'Columnas marítimas en ensambles', hint: 'Muestra las columnas 🚢 (m³, flete mar, landed mar, venta mar, Δ) en la tabla de componentes de cada ensamble. Solo cambia qué se ve: el costeo no cambia', boolean: true, booleanDefault: false, checkLabel: 'Mostrar las columnas 🚢 en la ficha del ensamble' },
  default_margin_pct:     { label: 'Margen por defecto (%)',       hint: 'Margen de ganancia al crear un producto; luego se ajusta por producto', rango: [0, 95] },
  presupuesto_validez_dias: { label: 'Validez del presupuesto (días)', hint: 'Cuántos días vale un presupuesto desde que se cotiza o renueva. Pasado el plazo no se puede confirmar: se renueva (nueva fecha y escalón BCV de hoy). Vacío = 7. Ojo: el texto de los términos dice "7 días"; si lo cambiás, cambialo también ahí', rango: [1, 365] },
  reclamo_horas:          { label: 'Plazo para reclamar (horas)', hint: 'Horas desde la entrega que el cliente tiene para reportar una pieza dañada, incorrecta o incompleta. Un reclamo fuera de plazo se anota igual, marcado, y vos decidís si se repone. Vacío = 48', rango: [1, 10000] },
  terminos_presupuesto:   { label: 'Términos y condiciones — Presupuesto', hint: 'Texto que aparece al pie del presupuesto al imprimir / guardar como PDF', multiline: true },
  terminos_pedido:        { label: 'Términos y condiciones — Pedido oficial', hint: 'Texto que aparece al pie del pedido confirmado al imprimir / guardar como PDF', multiline: true },
}

/** Nombre del campo oculto con el que el formulario dice "así estaba la base cuando me abriste". */
export const CAMPO_CARGADO = '__cargado'
