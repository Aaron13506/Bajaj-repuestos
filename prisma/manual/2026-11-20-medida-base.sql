-- Medidas en una sola base (docs/plan-inventario/04-medidas.md): en qué base están el peso y las
-- medidas guardados. Siempre por pieza: lo de caja se mide con su caja ('empaque'), lo de bolsa se
-- mide una pieza suelta ('pieza') y el peso sale de la bolsa entera dividida por lo que trae.

ALTER TABLE "Product" ADD COLUMN "medidaBase" TEXT;

ALTER TABLE "Product" ADD CONSTRAINT "Product_medidaBase_valida"
    CHECK ("medidaBase" IS NULL OR "medidaBase" IN ('pieza', 'empaque'));

-- Lo estimado ya es el bulto: desde 2026-08-21 el prompt de la IA (lib/prompts.ts) pide la pieza
-- con su caja o bolsa. Lo medido a mano queda en NULL: no se sabe en qué base se midió.
UPDATE "Product" SET "medidaBase" = 'empaque' WHERE "medidoAt" IS NULL;

-- El bulto como llegó a mis manos (07-casos-telefono.md, "al marcar la llegada"): peso y medidas
-- opcionales, para comparar contra lo que cobró el transportista. No entran al costeo: las cajas
-- que se facturan siguen siendo EnvioCaja.
ALTER TABLE "Envio" ADD COLUMN "llegadaPesoKg" DECIMAL(8,3), ADD COLUMN "llegadaLargoCm" DOUBLE PRECISION,
    ADD COLUMN "llegadaAnchoCm" DOUBLE PRECISION, ADD COLUMN "llegadaAltoCm" DOUBLE PRECISION;
