-- "El proveedor no la mandó": el proveedor vende el pedido pero alguna pieza la despacha después.
-- Se anota desde la compra como incidencia "sin_enviar" y, mientras esté abierta, la caja no espera
-- esas unidades al llegar (ver lib/incidencias.ts). Solo se amplía la lista de tipos válidos: nada
-- de lo ya anotado cambia.
ALTER TABLE "Incidencia" DROP CONSTRAINT "Incidencia_tipo_valido";
ALTER TABLE "Incidencia" ADD CONSTRAINT "Incidencia_tipo_valido"
  CHECK ("tipo" IN ('no_disponible', 'sin_enviar', 'danada', 'perdida', 'faltante', 'equivocada', 'defecto'));
