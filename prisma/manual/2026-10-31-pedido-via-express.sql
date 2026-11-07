-- Presupuestos express: Shoppre despacha directo a Venezuela (3 a 6 días) y el landed del
-- paquete tiene tope (Config express_tope_usd). La vía es del presupuesto entero porque el
-- flete es uno por paquete. Ver lib/express.ts.
ALTER TABLE "Pedido" ADD COLUMN "via" TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_via_valida" CHECK ("via" IN ('normal', 'express'));
-- El stock propio no se le vende a nadie: siempre viaja por la caja normal.
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_express_solo_cliente" CHECK ("via" = 'normal' OR "tipo" = 'cliente');
