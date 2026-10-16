-- El libro deja de ser un solo saldo en dólares: cada movimiento dice en qué cuenta entró o de
-- cuál salió, y si pasó en bolívares guarda cuántos y a qué tasa (ver lib/cuentas.ts). Las dos
-- patas de una conversión Bs → USDT comparten `grupo`.
ALTER TABLE "Movimiento"
  ADD COLUMN "cuenta"  TEXT,
  ADD COLUMN "montoBs" DECIMAL(16, 2),
  ADD COLUMN "tasaBs"  DECIMAL(14, 4),
  ADD COLUMN "grupo"   TEXT;

CREATE INDEX "Movimiento_cuenta_idx" ON "Movimiento"("cuenta");
CREATE INDEX "Movimiento_grupo_idx"  ON "Movimiento"("grupo");

-- Lo que ya está en el libro: la cuenta sale del método de pago con que se anotó. Los Bs y la
-- tasa NO se inventan: no se guardaron entonces, y quedan en NULL.
UPDATE "Movimiento" SET "cuenta" = CASE "metodoPago"
  WHEN 'Pago móvil / Transferencia Bs' THEN 'banco_bs'
  WHEN 'Efectivo USD'                  THEN 'efectivo_usd'
  WHEN 'Binance / USDT'                THEN 'usdt'
  WHEN 'Giro bancario'                 THEN 'banco_usd'
  WHEN 'Tarjeta'                       THEN 'banco_usd'
END
WHERE "metodoPago" IS NOT NULL;

ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_cuenta_valida"
  CHECK ("cuenta" IS NULL OR "cuenta" IN ('banco_bs', 'efectivo_usd', 'usdt', 'banco_usd'));

-- Bs y tasa van juntos o no van, y son positivos.
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_bs_con_tasa"
  CHECK (("montoBs" IS NULL AND "tasaBs" IS NULL)
      OR ("montoBs" > 0 AND "tasaBs" > 0));
