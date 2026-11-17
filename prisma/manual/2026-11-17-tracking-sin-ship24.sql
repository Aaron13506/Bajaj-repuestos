-- No queda nada de Ship24 en la base. Todo lo copiado del seguimiento (salvo One Way Cargo, que
-- no pasaba por Ship24) se borra: id, estado, sub-estado, pasos, hora de consulta, error y el
-- "ya lo vi" del inicio. Lo vuelve a traer Track123 en la próxima corrida.
--
-- Lo que llegó o dejó de seguirse con Ship24 queda además sin courierCode (los codes eran de
-- Ship24): un número solo anotado, con el nombre del courier que eligió el dueño, que se sigue
-- encontrando en /buscar. Así no se registra en Track123 (gastaría cupo para leer "entregado").
UPDATE "EnvioTracking" SET "courierCode" = NULL
WHERE "courierCode" IS NOT NULL
  AND "courierCode" <> 'onewaycargo'
  AND "estado" IN ('delivered', 'detenido');

UPDATE "EnvioTracking" SET
  "trackerId" = NULL,
  "estado" = NULL,
  "subestado" = NULL,
  "ultimoEvento" = NULL,
  "ultimoEventoEn" = NULL,
  "eventos" = NULL,
  "consultadoEn" = NULL,
  "errorSeguimiento" = NULL,
  "eventoVisto" = NULL
WHERE "courierCode" IS NULL OR "courierCode" <> 'onewaycargo';
