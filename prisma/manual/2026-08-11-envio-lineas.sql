-- AlterTable
ALTER TABLE "Envio" ADD COLUMN     "estado" TEXT NOT NULL DEFAULT 'confirmado';

-- CreateTable
CREATE TABLE "EnvioLinea" (
    "id" SERIAL NOT NULL,
    "envioId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvioLinea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvioLinea_envioId_idx" ON "EnvioLinea"("envioId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvioLinea_envioId_productId_key" ON "EnvioLinea"("envioId", "productId");

-- AddForeignKey
ALTER TABLE "EnvioLinea" ADD CONSTRAINT "EnvioLinea_envioId_fkey" FOREIGN KEY ("envioId") REFERENCES "Envio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvioLinea" ADD CONSTRAINT "EnvioLinea_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

