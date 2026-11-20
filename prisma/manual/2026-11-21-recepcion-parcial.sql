-- Recibo parcial: "recibir lo contado y seguir contando" (lib/recepcion.ts planParcial). La
-- recepción se cierra como parcial, recibe solo las líneas cubiertas enteras y abre la siguiente con
-- lo contado que no usó, anotado como lecturas 'arrastre'.

ALTER TABLE "Recepcion" ADD COLUMN "parcial" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RecepcionLectura" DROP CONSTRAINT "RecepcionLectura_origen_valido";
ALTER TABLE "RecepcionLectura" ADD CONSTRAINT "RecepcionLectura_origen_valido"
  CHECK ("origen" IN ('camara', 'lector', 'manual', 'arrastre'));
