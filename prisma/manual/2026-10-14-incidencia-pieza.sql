-- Un "no disponible" casi nunca es el conjunto entero: es UNA pieza (un SKU) de un conjunto que
-- el proveedor no tiene. Hasta ahora la incidencia colgaba de la línea y no decía cuál, así que
-- solo se cerraba sacando la línea entera del pedido.
--
-- `pieza` es la etiqueta de la pieza del conjunto («Nombre (CÓDIGO)»); null = la línea entera
-- (una pieza suelta, o un problema que no es de una pieza en particular). Nada de lo ya anotado
-- cambia: las incidencias existentes quedan con null.
ALTER TABLE "Incidencia" ADD COLUMN "pieza" TEXT;
