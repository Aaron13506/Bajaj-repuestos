-- AlterTable
ALTER TABLE "Envio" ADD COLUMN     "supplierId" INTEGER;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "fobUsd" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "Envio_supplierId_idx" ON "Envio"("supplierId");

-- AddForeignKey
ALTER TABLE "Envio" ADD CONSTRAINT "Envio_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

