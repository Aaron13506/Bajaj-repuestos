-- Novedades del inicio: el último evento de cada tracking que el dueño ya vio («Ya lo vi»),
-- como `fecha|detalle` (claveEvento en lib/ship24.ts). Se compara por igualdad con el último
-- evento guardado, no por hora: la hora es la del courier y la sincronización llega después.
-- Null = nunca visto: al aplicar, todo tracking con eventos aparece una vez como novedad.
ALTER TABLE "EnvioTracking" ADD COLUMN "eventoVisto" TEXT;
