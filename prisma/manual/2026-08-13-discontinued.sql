-- Piezas descontinuadas de fábrica.
--
-- Bajaj deja de producir un SKU y 99rpm lo rotula "(Discontinued/Supply-Disruption/NLS)".
-- Es un hecho de la FÁBRICA, no del proveedor: si no se produce, no la consigue nadie, así
-- que la marca vive en Product (y en ScrapedPart como espejo del scrape) y no en
-- SupplierPrice. Ver los comentarios de ambos modelos en schema.prisma.
--
-- Product.discontinuedAt es fecha y no booleano: NULL = vigente, y cuando está marcada
-- registra desde cuándo lo sabemos — es lo que permite releer un presupuesto viejo sin
-- concluir que se cotizó algo imposible.

-- IF NOT EXISTS porque estos archivos se corren a mano y sin registro de cuáles ya se
-- aplicaron: sin eso, re-correrlo aborta con "column already exists" y deja la duda de si
-- llegó a tocar algo.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "discontinuedAt" TIMESTAMP(3);
ALTER TABLE "ScrapedPart" ADD COLUMN IF NOT EXISTS "discontinued" BOOLEAN NOT NULL DEFAULT false;

-- Sin índice a propósito. La consulta que corre en todas las pantallas es "las vigentes"
-- (discontinuedAt IS NULL), que matchea a casi todas las filas y por lo tanto se resuelve
-- con seq scan igual; y las marcadas son ~300 sobre 5.778, un scan de nada. Un índice
-- parcial acá solo agregaría algo que schema.prisma no puede describir, y el próximo
-- `prisma migrate` querría borrarlo.
