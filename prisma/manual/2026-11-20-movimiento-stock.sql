-- Kardex: libro de movimientos de stock (docs/plan-inventario/02-kardex.md). MovimientoStock es la
-- verdad y Product.stock su caché, que mantiene solo lib/stock.ts (moverStock).

-- Stock nunca negativo: se verifica antes de crear nada, así --probar falla legible.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "stock" < 0) THEN
    RAISE EXCEPTION 'Hay piezas con stock negativo: corregirlas antes de migrar (pnpm check:libro las lista).';
  END IF;
END $$;

CREATE TABLE "MovimientoStock" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "costoUnitUsd" DECIMAL(10,2),
    "nota" TEXT,
    "envioId" INTEGER,
    "pedidoId" INTEGER,
    "pedidoItemId" INTEGER,
    "recepcionId" INTEGER,
    "grupo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovimientoStock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MovimientoStock_cantidad_no_cero" CHECK ("cantidad" <> 0),
    -- La misma lista que MOTIVOS_STOCK en lib/stock.ts.
    CONSTRAINT "MovimientoStock_motivo_valido" CHECK ("motivo" IN (
      'saldo_inicial', 'alta', 'ajuste', 'recepcion', 'reversa_recepcion', 'entrega_propio',
      'reversa_entrega_propio', 'edicion_pedido', 'servido_pedido', 'devuelto_deposito', 'venta',
      'anulacion_venta', 'sobrante_recepcion', 'conteo'
    ))
);

CREATE INDEX "MovimientoStock_productId_createdAt_idx" ON "MovimientoStock"("productId", "createdAt");
CREATE INDEX "MovimientoStock_envioId_idx" ON "MovimientoStock"("envioId");
CREATE INDEX "MovimientoStock_pedidoId_idx" ON "MovimientoStock"("pedidoId");
CREATE INDEX "MovimientoStock_grupo_idx" ON "MovimientoStock"("grupo");

ALTER TABLE "MovimientoStock" ADD CONSTRAINT "MovimientoStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MovimientoStock" ADD CONSTRAINT "MovimientoStock_envioId_fkey" FOREIGN KEY ("envioId") REFERENCES "Envio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MovimientoStock" ADD CONSTRAINT "MovimientoStock_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MovimientoStock" ADD CONSTRAINT "MovimientoStock_pedidoItemId_fkey" FOREIGN KEY ("pedidoItemId") REFERENCES "PedidoItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Saldo inicial: el libro cuadra desde el primer día.
INSERT INTO "MovimientoStock" ("productId", "cantidad", "motivo", "nota", "grupo")
SELECT "id", "stock", 'saldo_inicial', 'Stock al crear el libro', 'saldo_inicial'
FROM "Product" WHERE "stock" <> 0;

ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_no_negativo" CHECK ("stock" >= 0);
