-- El seguimiento automático pasa de TrackingMore a Ship24 (lib/ship24.ts).
--
-- El id de TrackingMore no sirve en Ship24: la columna pasa a ser el trackerId de Ship24 y
-- se vacía, igual que el estado copiado, para que la próxima corrida cree cada tracker en
-- Ship24 y traiga su estado. El courierCode se conserva: si Ship24 usa el mismo code, sigue
-- igual; si no, la corrida lo marca en la fila para elegirlo de nuevo. La lista de couriers de
-- TrackingMore se borra; la próxima corrida baja la de Ship24.
ALTER TABLE "EnvioTracking" RENAME COLUMN "tmId" TO "trackerId";

UPDATE "EnvioTracking" SET
  "trackerId" = NULL,
  "estado" = NULL,
  "subestado" = NULL,
  "ultimoEvento" = NULL,
  "ultimoEventoEn" = NULL,
  "eventos" = NULL,
  "consultadoEn" = NULL,
  "errorSeguimiento" = NULL;

DELETE FROM "TrackingCourier";
