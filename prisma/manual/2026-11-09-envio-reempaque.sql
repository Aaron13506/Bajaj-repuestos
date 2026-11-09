-- El reempaque del depósito es de cada caja (un paquete cuesta ₹100 y otro ₹1000), no un
-- número fijo en /config. Vale para Shoppre, el reenvío por kilo y el express. Ver lib/reenvio.ts.
ALTER TABLE "Envio" ADD COLUMN "reempaqueInr" DECIMAL(10,2);
ALTER TABLE "Envio" ADD CONSTRAINT "Envio_reempaqueInr_no_negativo" CHECK ("reempaqueInr" IS NULL OR "reempaqueInr" >= 0);

-- Las cajas por kilo que ya se costeaban con los gastos fijos de /config los conservan, así su
-- landed no cambia solo. Después la clave se borra: ya no la lee nadie.
UPDATE "Envio" SET "reempaqueInr" = c."value"::numeric
FROM "Config" c
WHERE c."key" = 'reenvio_kilo_gastos_inr' AND c."value" ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
  AND "Envio"."reenvio" = 'por_kilo';
DELETE FROM "Config" WHERE "key" = 'reenvio_kilo_gastos_inr';
