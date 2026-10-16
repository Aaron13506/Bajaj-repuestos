-- Cada línea comprada recuerda el egreso que la pagó (PedidoItem.compraId), para que borrar ese
-- egreso deshaga la compra: las líneas vuelven a quedar sin costo real y se pueden registrar de
-- nuevo. Antes, borrar un pago mal cargado dejaba el costo en las líneas sin forma de corregirlo.
-- Lo ya comprado queda en NULL: no se sabe con qué egreso se pagó y no se adivina.
ALTER TABLE "PedidoItem" ADD COLUMN "compraId" INTEGER;

ALTER TABLE "PedidoItem"
  ADD CONSTRAINT "PedidoItem_compraId_fkey"
  FOREIGN KEY ("compraId") REFERENCES "Movimiento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PedidoItem_compraId_idx" ON "PedidoItem"("compraId");
