-- Apaga el conteo ciego por defecto en recepciones (el interruptor sigue disponible en la laptop).
ALTER TABLE "Recepcion" ALTER COLUMN "ciego" SET DEFAULT false;
UPDATE "Recepcion" SET "ciego" = false WHERE "cerradaAt" IS NULL;
