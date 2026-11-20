-- Ubicaciones y conteo cíclico (docs/plan-inventario/05-ubicaciones-conteo.md). Los ajustes del
-- conteo son movimientos 'conteo' del kardex (lib/stock.ts moverStock); el motivo ya existe.

ALTER TABLE "Product" ADD COLUMN "ubicacion" TEXT;
ALTER TABLE "Product" ADD COLUMN "contadoAt" TIMESTAMP(3);
CREATE INDEX "Product_ubicacion_idx" ON "Product"("ubicacion");

CREATE TABLE "ConteoInventario" (
    "id" SERIAL NOT NULL,
    "ubicacion" TEXT,
    "abiertoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerradoAt" TIMESTAMP(3),
    "notas" TEXT,

    CONSTRAINT "ConteoInventario_pkey" PRIMARY KEY ("id")
);

-- Un solo conteo abierto por estante: dos pantallas que lo abren a la vez caen en el mismo.
CREATE UNIQUE INDEX "ConteoInventario_uno_abierto" ON "ConteoInventario" ("ubicacion") WHERE "cerradoAt" IS NULL;

CREATE TABLE "ConteoInventarioLinea" (
    "id" SERIAL NOT NULL,
    "conteoId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "sistema" INTEGER NOT NULL,
    "contado" INTEGER,

    CONSTRAINT "ConteoInventarioLinea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConteoInventarioLinea_contado_no_negativo" CHECK ("contado" >= 0)
);

CREATE UNIQUE INDEX "ConteoInventarioLinea_conteoId_productId_key" ON "ConteoInventarioLinea"("conteoId", "productId");

ALTER TABLE "ConteoInventarioLinea" ADD CONSTRAINT "ConteoInventarioLinea_conteoId_fkey" FOREIGN KEY ("conteoId") REFERENCES "ConteoInventario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConteoInventarioLinea" ADD CONSTRAINT "ConteoInventarioLinea_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
