-- Recepción: llegada, conteo persistido, cierre y backorder (docs/plan-inventario/03-recepcion.md).

ALTER TABLE "Envio" ADD COLUMN "llegadaAt" TIMESTAMP(3), ADD COLUMN "llegadaNota" TEXT;

CREATE TABLE "Recepcion" (
    "id" SERIAL NOT NULL,
    "envioId" INTEGER NOT NULL,
    "ciego" BOOLEAN NOT NULL DEFAULT true,
    "abiertaAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerradaAt" TIMESTAMP(3),
    "revertidaAt" TIMESTAMP(3),
    "notas" TEXT,
    "itemsMovidos" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "Recepcion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Recepcion_revertida_solo_cerrada" CHECK ("revertidaAt" IS NULL OR "cerradaAt" IS NOT NULL)
);
CREATE INDEX "Recepcion_envioId_idx" ON "Recepcion"("envioId");
-- Una sola abierta por caja.
CREATE UNIQUE INDEX "Recepcion_una_abierta" ON "Recepcion" ("envioId") WHERE "cerradaAt" IS NULL;
ALTER TABLE "Recepcion" ADD CONSTRAINT "Recepcion_envioId_fkey" FOREIGN KEY ("envioId") REFERENCES "Envio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RecepcionLinea" (
    "id" SERIAL NOT NULL,
    "recepcionId" INTEGER NOT NULL,
    "codigo" TEXT,
    "productId" INTEGER,
    "nombre" TEXT NOT NULL,
    "esperado" INTEGER NOT NULL,
    "contado" INTEGER,
    "decision" TEXT,
    "nota" TEXT,

    CONSTRAINT "RecepcionLinea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecepcionLinea_decision_valida" CHECK ("decision" IS NULL OR "decision" IN ('backorder', 'faltante', 'equivocada')),
    CONSTRAINT "RecepcionLinea_esperado_no_negativo" CHECK ("esperado" >= 0),
    CONSTRAINT "RecepcionLinea_contado_no_negativo" CHECK ("contado" IS NULL OR "contado" >= 0)
);
CREATE UNIQUE INDEX "RecepcionLinea_recepcionId_codigo_key" ON "RecepcionLinea"("recepcionId", "codigo");
ALTER TABLE "RecepcionLinea" ADD CONSTRAINT "RecepcionLinea_recepcionId_fkey" FOREIGN KEY ("recepcionId") REFERENCES "Recepcion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecepcionLinea" ADD CONSTRAINT "RecepcionLinea_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RecepcionLectura" (
    "id" SERIAL NOT NULL,
    "recepcionId" INTEGER NOT NULL,
    "lineaId" INTEGER NOT NULL,
    "raw" TEXT,
    "cantidad" INTEGER NOT NULL,
    "origen" TEXT NOT NULL,
    "anuladaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecepcionLectura_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecepcionLectura_origen_valido" CHECK ("origen" IN ('camara', 'lector', 'manual'))
);
CREATE INDEX "RecepcionLectura_recepcionId_createdAt_idx" ON "RecepcionLectura"("recepcionId", "createdAt");
CREATE INDEX "RecepcionLectura_lineaId_idx" ON "RecepcionLectura"("lineaId");
ALTER TABLE "RecepcionLectura" ADD CONSTRAINT "RecepcionLectura_recepcionId_fkey" FOREIGN KEY ("recepcionId") REFERENCES "Recepcion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecepcionLectura" ADD CONSTRAINT "RecepcionLectura_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "RecepcionLinea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Incidencia" ADD COLUMN "recepcionId" INTEGER, ADD COLUMN "recepcionCierreId" INTEGER;
ALTER TABLE "Incidencia" ADD CONSTRAINT "Incidencia_recepcionId_fkey" FOREIGN KEY ("recepcionId") REFERENCES "Recepcion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Incidencia" ADD CONSTRAINT "Incidencia_recepcionCierreId_fkey" FOREIGN KEY ("recepcionCierreId") REFERENCES "Recepcion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MovimientoStock" ADD CONSTRAINT "MovimientoStock_recepcionId_fkey" FOREIGN KEY ("recepcionId") REFERENCES "Recepcion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cajas que ya llegaron antes de esto: no vuelven a pedir conteo. No se les crea Recepcion; la
-- pantalla dice "Recibida antes del registro de recepciones".
UPDATE "Envio" SET "llegadaAt" = COALESCE("entregadoAt", "updatedAt")
WHERE "modo" = 'maritimo_cbm' AND "estado" = 'entregado';

-- Aéreas: la primera vez que una línea de la caja pasó a en_venezuela. Las líneas viejas no tienen
-- historial de etapas: sin él, la fecha de su último cambio de etapa (o de la caja).
UPDATE "Envio" e SET "llegadaAt" = COALESCE(l.at, e."updatedAt")
FROM (
  SELECT pi."envioId", COALESCE(MIN(h."at"), MIN(pi."shippingStatusAt")) AS at
  FROM "PedidoItem" pi
  LEFT JOIN "PedidoItemEtapa" h ON h."itemId" = pi."id" AND h."hacia" = 'en_venezuela'
  WHERE pi."envioId" IS NOT NULL AND NOT pi."isLanded" AND pi."shippingStatus" IN ('en_venezuela', 'entregado')
  GROUP BY pi."envioId"
) l
WHERE e."id" = l."envioId" AND e."modo" <> 'maritimo_cbm';
