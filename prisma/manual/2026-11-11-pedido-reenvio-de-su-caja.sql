-- El reenvío de un pedido por Miami ahora decide en qué caja aérea viaja (lib/reenvio.ts,
-- motivoReenvioNoCoincide): uno cotizado por kilo va solo en una caja aérea por kilo, y uno por
-- Shoppre solo en una Shoppre. Hasta hoy todos los pedidos normales decían 'shoppre', también los
-- que ya viajan en cajas por kilo. Esto los alinea con el reenvío (y el ₹/kg) de la caja aérea
-- donde están sus líneas.
--
-- Solo datos, sin cambio de esquema. Los pedidos con líneas repartidas entre cajas de los dos
-- reenvíos quedan afuera (HAVING): se revisan a mano. Las líneas que ya viajan no se mueven: la
-- regla traba al entrar a una caja, no revisa lo que ya está adentro.
UPDATE "Pedido" p SET "reenvio" = e."reenvio", "tarifaKgInr" = e."tarifaKgInr"
FROM (
  SELECT i."pedidoId", MIN(en."reenvio") AS "reenvio", MAX(en."tarifaKgInr") AS "tarifaKgInr"
  FROM "PedidoItem" i JOIN "Envio" en ON en.id = i."envioId"
  WHERE en."modo" = 'aereo'
  GROUP BY i."pedidoId"
  HAVING COUNT(DISTINCT en."reenvio") = 1
) e
WHERE p.id = e."pedidoId" AND p."via" = 'normal' AND p."reenvio" <> e."reenvio";

-- Los que quedaron afuera (líneas en cajas aéreas de los dos reenvíos), para revisarlos a mano:
--   SELECT i."pedidoId", array_agg(DISTINCT en.id) AS cajas, array_agg(DISTINCT en."reenvio") AS reenvios
--   FROM "PedidoItem" i JOIN "Envio" en ON en.id = i."envioId"
--   JOIN "Pedido" p ON p.id = i."pedidoId"
--   WHERE en."modo" = 'aereo' AND p."via" = 'normal'
--   GROUP BY i."pedidoId" HAVING COUNT(DISTINCT en."reenvio") > 1;
