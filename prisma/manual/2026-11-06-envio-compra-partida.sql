-- Caja partida en el depósito: se mueve un presupuesto de una caja a otra con la etapa que
-- tiene (ver lib/mover-caja.ts). Las dos siguen siendo una sola compra al proveedor: lo debido
-- y lo pagado se suman por compra. compraDeId apunta a la caja raíz; null = su propia compra.
ALTER TABLE "Envio" ADD COLUMN "compraDeId" INTEGER;

CREATE INDEX "Envio_compraDeId_idx" ON "Envio"("compraDeId");

ALTER TABLE "Envio" ADD CONSTRAINT "Envio_compraDeId_fkey" FOREIGN KEY ("compraDeId") REFERENCES "Envio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una caja no es su propia compra (la raíz tiene null).
ALTER TABLE "Envio" ADD CONSTRAINT "Envio_compraDeId_no_ella_misma" CHECK ("compraDeId" IS NULL OR "compraDeId" <> "id");
