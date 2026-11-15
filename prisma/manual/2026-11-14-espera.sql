-- Lista de espera: clientes que preguntaron por una pieza sin pedirla, para avisarles primero cuando
-- haya stock. Se borra al avisar; borrar el cliente o la pieza borra su espera.
CREATE TABLE "Espera" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "nota" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Espera_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Espera_clienteId_productId_key" ON "Espera"("clienteId", "productId");
CREATE INDEX "Espera_productId_idx" ON "Espera"("productId");

ALTER TABLE "Espera" ADD CONSTRAINT "Espera_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Espera" ADD CONSTRAINT "Espera_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
