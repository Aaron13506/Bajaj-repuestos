-- Una pieza chica (arandela, clip) pesa 1,5 g: en gramos enteros el redondeo es un 33% del
-- peso. Pasa a admitir la décima; los enteros guardados quedan iguales.
ALTER TABLE "Product" ALTER COLUMN "weightGrams" TYPE DOUBLE PRECISION;
