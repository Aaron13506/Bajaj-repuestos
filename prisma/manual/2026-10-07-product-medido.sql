-- Peso y medidas tomados a mano (balanza y cinta) en vez de estimados. Ver Product.medidoAt.
-- Todo el catálogo existente queda en NULL: hoy cada peso es una estimación.
ALTER TABLE "Product" ADD COLUMN "medidoAt" TIMESTAMP(3);
