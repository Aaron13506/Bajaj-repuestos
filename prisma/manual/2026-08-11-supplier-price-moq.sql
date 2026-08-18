-- Múltiplo mínimo de compra por (producto, proveedor). Ver el comentario del modelo
-- SupplierPrice en schema.prisma: el precio sigue siendo por pieza, el MOQ multiplica
-- la cantidad. NULL = el proveedor no lo declara.

-- IF NOT EXISTS porque estos archivos se corren a mano y sin registro de cuáles ya se
-- aplicaron: sin eso, re-correrlo aborta con "column already exists" y deja la duda de
-- si llegó a tocar algo. El import de precios ya es idempotente; esto lo empareja.

-- AlterTable
ALTER TABLE "SupplierPrice" ADD COLUMN IF NOT EXISTS "moq" INTEGER;
