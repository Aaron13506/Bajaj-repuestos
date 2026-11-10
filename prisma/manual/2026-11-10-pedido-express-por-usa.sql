-- Un presupuesto express elige su ruta sin necesitar caja: Shoppre directo (con tope) o por USA
-- (reenvío por kilo + One Way aéreo, sin tope), con el ₹/kg con el que se cotizó. Ver lib/express.ts.
ALTER TABLE "Pedido" ADD COLUMN "reenvio" TEXT NOT NULL DEFAULT 'shoppre';
ALTER TABLE "Pedido" ADD COLUMN "tarifaKgInr" DECIMAL(10,2);

ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_reenvio_valido" CHECK ("reenvio" IN ('shoppre', 'por_kilo'));
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_tarifaKgInr_no_negativa" CHECK ("tarifaKgInr" IS NULL OR "tarifaKgInr" >= 0);
