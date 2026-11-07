-- Varias cajas por envío, con reempaque. Una entrega llega al depósito en varios paquetes y
-- el depósito puede reempacarlos en otras cajas antes de despacharlos: lo que se factura son
-- las cajas que salen, y las que llegaron quedan como registro. Reemplaza a la caja única
-- (pesoRealKg + cajaL/A/H). Ver lib/cajas-envio.ts.
CREATE TABLE "EnvioCaja" (
    "id" SERIAL NOT NULL,
    "envioId" INTEGER NOT NULL,
    "etapa" TEXT NOT NULL,
    "referencia" TEXT,
    "pesoKg" DECIMAL(8,3),
    "largoCm" DOUBLE PRECISION,
    "anchoCm" DOUBLE PRECISION,
    "altoCm" DOUBLE PRECISION,

    CONSTRAINT "EnvioCaja_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnvioCaja_envioId_idx" ON "EnvioCaja"("envioId");

ALTER TABLE "EnvioCaja" ADD CONSTRAINT "EnvioCaja_envioId_fkey" FOREIGN KEY ("envioId") REFERENCES "Envio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EnvioCaja" ADD CONSTRAINT "EnvioCaja_etapa_valida" CHECK ("etapa" IN ('llegada', 'salida'));
-- Vacío es "no se sabe", nunca cero: un 0 se guarda como NULL (lo hace la acción).
ALTER TABLE "EnvioCaja" ADD CONSTRAINT "EnvioCaja_medidas_positivas" CHECK (
    ("pesoKg" IS NULL OR "pesoKg" > 0) AND ("largoCm" IS NULL OR "largoCm" > 0)
    AND ("anchoCm" IS NULL OR "anchoCm" > 0) AND ("altoCm" IS NULL OR "altoCm" > 0)
);

ALTER TABLE "Envio" ADD COLUMN "reempaque" BOOLEAN NOT NULL DEFAULT false;

-- La caja única que había pasa a ser la primera caja de llegada (sin reempaque, es la que
-- viaja). Las medidas a medias se copian como estaban; un 0 viejo era "sin dato".
INSERT INTO "EnvioCaja" ("envioId", "etapa", "pesoKg", "largoCm", "anchoCm", "altoCm")
SELECT "id", 'llegada',
       NULLIF("pesoRealKg", 0), NULLIF("cajaL", 0), NULLIF("cajaA", 0), NULLIF("cajaH", 0)
FROM "Envio"
WHERE COALESCE("pesoRealKg", 0) > 0 OR COALESCE("cajaL", 0) > 0 OR COALESCE("cajaA", 0) > 0 OR COALESCE("cajaH", 0) > 0;

ALTER TABLE "Envio" DROP COLUMN "pesoRealKg";
ALTER TABLE "Envio" DROP COLUMN "cajaL";
ALTER TABLE "Envio" DROP COLUMN "cajaA";
ALTER TABLE "Envio" DROP COLUMN "cajaH";
