-- El seguimiento automático pasa de Ship24 a Track123 (lib/track123.ts).
--
-- Lo que ya llegó o dejó de seguirse (delivered/detenido) no cambia más: queda como está y no
-- se registra en Track123 (sería gastar cupo para volver a leer "entregado"). Lo One Way Cargo
-- tampoco se toca (no pasa por ninguno de los dos).
--
-- El resto se vacía de lo de Ship24 (su trackerId no sirve en Track123, y un error suyo ya no
-- aplica) para que la próxima corrida lo registre en Track123. El estado y los eventos que se
-- ven se conservan hasta que llegue lo de Track123. El courierCode se conserva: si Track123 usa
-- el mismo code, sigue igual; si no, la corrida lo marca en la fila para elegirlo de nuevo.
--
-- La lista de couriers de Ship24 se borra; la próxima corrida baja la de Track123, que no
-- trae país.
UPDATE "EnvioTracking" SET
  "trackerId" = NULL,
  "errorSeguimiento" = NULL
WHERE "courierCode" IS NOT NULL
  AND "courierCode" <> 'onewaycargo'
  AND ("estado" IS NULL OR "estado" NOT IN ('delivered', 'detenido'));

DELETE FROM "TrackingCourier";

ALTER TABLE "TrackingCourier" DROP COLUMN "pais";
