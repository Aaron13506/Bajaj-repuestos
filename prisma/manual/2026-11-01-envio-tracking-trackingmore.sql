-- Seguimiento automático de los trackings de la caja con TrackingMore. Cada tracking puede
-- llevar el courier_code de TrackingMore; con él, pnpm tracking:sync lo registra y copia su
-- estado cada hora. Sin él sigue siendo un número anotado, como hasta ahora.
-- Ver lib/trackingmore.ts y lib/sync-trackings.ts.
ALTER TABLE "EnvioTracking"
  ADD COLUMN "courierCode" TEXT,
  ADD COLUMN "tmId" TEXT,
  ADD COLUMN "estado" TEXT,
  ADD COLUMN "subestado" TEXT,
  ADD COLUMN "ultimoEvento" TEXT,
  ADD COLUMN "ultimoEventoEn" TEXT,
  ADD COLUMN "eventos" JSONB,
  ADD COLUMN "consultadoEn" TIMESTAMP(3),
  ADD COLUMN "errorSeguimiento" TEXT;

CREATE TABLE "TrackingCourier" (
    "code" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "pais" TEXT,
    "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingCourier_pkey" PRIMARY KEY ("code")
);
