-- Varios números de tracking por caja y por tramo, en vez de una sola guía. El proveedor
-- despacha en dos o tres paquetes y da un número local por cada uno; el reenvío a USA y el
-- courier a Venezuela pueden partir la carga igual. Ver lib/tracking.ts.
CREATE TABLE "EnvioTracking" (
    "id" SERIAL NOT NULL,
    "envioId" INTEGER NOT NULL,
    "tramo" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "transportista" TEXT,

    CONSTRAINT "EnvioTracking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnvioTracking_envioId_tramo_numero_key" ON "EnvioTracking"("envioId", "tramo", "numero");
CREATE INDEX "EnvioTracking_numero_idx" ON "EnvioTracking"("numero");

ALTER TABLE "EnvioTracking" ADD CONSTRAINT "EnvioTracking_envioId_fkey" FOREIGN KEY ("envioId") REFERENCES "Envio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EnvioTracking" ADD CONSTRAINT "EnvioTracking_tramo_valido" CHECK ("tramo" IN ('local', 'usa', 'venezuela'));
ALTER TABLE "EnvioTracking" ADD CONSTRAINT "EnvioTracking_numero_no_vacio" CHECK (btrim("numero") <> '');

-- La guía única que había era la del reenvío a USA (Shoppre): pasa a ese tramo.
INSERT INTO "EnvioTracking" ("envioId", "tramo", "numero", "transportista")
SELECT "id", 'usa', btrim("guia"), NULLIF(btrim("transportista"), '')
FROM "Envio"
WHERE "guia" IS NOT NULL AND btrim("guia") <> '';

-- Un transportista anotado sin guía no tiene número al que colgarse: se guarda en las notas
-- de la caja para no perderlo.
UPDATE "Envio"
SET "notas" = concat_ws(E'\n', NULLIF("notas", ''), 'Transportista: ' || btrim("transportista"))
WHERE ("guia" IS NULL OR btrim("guia") = '') AND "transportista" IS NOT NULL AND btrim("transportista") <> '';

ALTER TABLE "Envio" DROP COLUMN "guia";
ALTER TABLE "Envio" DROP COLUMN "transportista";
