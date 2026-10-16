-- Un presupuesto que el cliente no aceptó quedaba abierto para siempre: no se sabía qué
-- porcentaje se convierte en pedido ni a quién seguir. "Perdido" lo cierra sin borrarlo.
--
-- Sigue siendo status = 'presupuesto' a propósito: medio sistema lee `status <> 'presupuesto'`
-- como "confirmado", y un estado nuevo caería de ese lado. Se reabre vaciando la fecha.
ALTER TABLE "Pedido" ADD COLUMN "perdidoAt" TIMESTAMP(3);
ALTER TABLE "Pedido" ADD COLUMN "perdidoMotivo" TEXT;

-- Solo un presupuesto se pierde: uno confirmado se cancela (canceladoAt).
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_perdido_solo_presupuesto"
  CHECK ("perdidoAt" IS NULL OR "status" = 'presupuesto');
