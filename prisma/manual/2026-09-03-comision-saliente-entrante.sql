-- La comisión del giro son DOS montos, no uno.
--
-- `comisionUsd` guardaba "lo que costó la transferencia", como si fuera un número. No lo
-- es: un giro internacional se cobra en las dos puntas y las dos son costo mío.
--
--   SALIENTE  lo que mi banco me descuenta por emitirlo. Se sabe el mismo día.
--   ENTRANTE  lo que el corresponsal y el banco del proveedor le descuentan al acreditar.
--             No aparece en mi cuenta: aparece en que él avisa que recibió menos que lo
--             facturado y hay que completarle la diferencia.
--
-- Con una sola columna no se podía anotar la primera sin inventar la segunda, y en este
-- modelo vacío ≠ cero: el invento entraba al landed que define los precios de venta.
-- Ahora cada punta se anota cuando se sabe, y el giro está costeado recién con las dos.
--
-- La columna vieja se RENOMBRA a saliente en vez de borrarse: lo que hay anotado ahí es
-- lo que cobró mi banco, que es exactamente la saliente. La entrante nace en NULL —
-- "no se anotó"— y no en 0, porque nadie verificó todavía cuánto le descontaron.

-- AlterTable
ALTER TABLE "Envio" RENAME COLUMN "comisionUsd" TO "comisionSalienteUsd";

-- AlterTable
ALTER TABLE "Envio" ADD COLUMN "comisionEntranteUsd" DECIMAL(10,2);
