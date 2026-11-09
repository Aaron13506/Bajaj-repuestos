-- El stock propio también puede ir por express: cuando una caja express tiene espacio bajo el
-- tope, se aprovecha para traer stock. La vía sigue siendo del pedido entero (Pedido_via_valida).
ALTER TABLE "Pedido" DROP CONSTRAINT "Pedido_express_solo_cliente";
