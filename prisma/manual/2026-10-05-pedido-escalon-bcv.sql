-- Escalón de brecha BCV congelado al confirmar un pedido de cliente (ver lib/cobro-bcv.ts).
-- Los pedidos existentes quedan en NULL: se cobraron en dólares reales y así siguen.
ALTER TABLE "Pedido" ADD COLUMN "brechaEscalonPct" DECIMAL(5, 2);

ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_brechaEscalonPct_rango"
  CHECK ("brechaEscalonPct" IS NULL OR ("brechaEscalonPct" > 0 AND "brechaEscalonPct" < 100));
