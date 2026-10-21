-- Un segundo reenvío India → USA además de Shoppre: cotiza el precio por kilo en rupias en el
-- momento, según el tamaño del envío, y suma gastos fijos por caja (Config
-- reenvio_kilo_gastos_inr). Se elige por caja, no por proveedor. Ver lib/reenvio.ts.
ALTER TABLE "Envio" ADD COLUMN "reenvio" TEXT NOT NULL DEFAULT 'shoppre';
ALTER TABLE "Envio" ADD COLUMN "tarifaKgInr" DECIMAL(10,2);

ALTER TABLE "Envio" ADD CONSTRAINT "Envio_reenvio_valido" CHECK ("reenvio" IN ('shoppre', 'por_kilo'));
-- Una tarifa negativa no existe; cero sí podría ser un dato (envío regalado), así que se acepta.
ALTER TABLE "Envio" ADD CONSTRAINT "Envio_tarifaKgInr_no_negativa" CHECK ("tarifaKgInr" IS NULL OR "tarifaKgInr" >= 0);
