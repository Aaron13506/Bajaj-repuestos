-- La caja como la pesó y midió el transportista. Ver el comentario del modelo Envio en
-- schema.prisma: el catálogo guarda la pieza DESNUDA y la balanza pesa el BULTO (cada
-- repuesto con su caja, el cartón exterior y el relleno), así que sumar piezas sueltas es
-- un piso y nunca puede sobreestimar. Medido contra el envío real 64898: +19% de peso y
-- +56% de volumen, que se pagan dos veces (escalón de ShipGlobal + ft³ Miami→CCS).
--
-- Todo NULL: "todavía no lo sé" no es cero, y un 0 haría desaparecer la caja del cálculo.

-- AlterTable
ALTER TABLE "Envio" ADD COLUMN     "pesoRealKg" DECIMAL(8,3);
ALTER TABLE "Envio" ADD COLUMN     "cajaL" DOUBLE PRECISION;
ALTER TABLE "Envio" ADD COLUMN     "cajaA" DOUBLE PRECISION;
ALTER TABLE "Envio" ADD COLUMN     "cajaH" DOUBLE PRECISION;
