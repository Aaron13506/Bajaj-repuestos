-- La caja express con la que se costeó un presupuesto express. Un presupuesto de cliente no entra
-- a la caja hasta confirmarse con su adelanto: hasta ahí la caja es solo la referencia del costeo.
ALTER TABLE "Pedido" ADD COLUMN "cajaExpressId" INTEGER;
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_cajaExpressId_fkey"
  FOREIGN KEY ("cajaExpressId") REFERENCES "Envio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
