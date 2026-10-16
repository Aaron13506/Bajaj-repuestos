-- Una línea de un pedido de cliente que se sirve con lo que ya hay en el depósito: no se compra
-- ni viaja en una caja. Al servirla se descuenta Product.stock y se congela su costo en
-- costRealUsd (lo que valía en el inventario), como una venta del depósito.
ALTER TABLE "PedidoItem" ADD COLUMN "desdeStock" BOOLEAN NOT NULL DEFAULT false;

-- Servida desde el depósito ⇒ pieza suelta, fuera de toda caja y con su costo.
ALTER TABLE "PedidoItem" ADD CONSTRAINT "PedidoItem_desde_stock_coherente"
  CHECK (NOT "desdeStock" OR ("envioId" IS NULL AND "productId" IS NOT NULL AND "costRealUsd" IS NOT NULL));
